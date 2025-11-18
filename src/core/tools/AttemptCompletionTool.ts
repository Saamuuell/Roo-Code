import Anthropic from "@anthropic-ai/sdk"
import * as vscode from "vscode"

import { RooCodeEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../task/Task"
import {
	AskApproval,
	AskFinishSubTaskApproval,
	HandleError,
	PushToolResult,
	RemoveClosingTag,
	ToolDescription,
	ToolResponse,
	ToolUse,
} from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"

export interface AttemptCompletionCallbacks {
	askApproval: AskApproval
	handleError: HandleError
	pushToolResult: PushToolResult
	removeClosingTag: RemoveClosingTag
	toolDescription: ToolDescription
	askFinishSubTaskApproval: AskFinishSubTaskApproval
}

/**
 * Core implementation of the attempt_completion tool.
 * This version is used by presentAssistantMessage via the .handle(...) wrapper
 * and mirrors the behavior previously implemented in the function-based tool.
 */
async function handleAttemptCompletionInternal(
	cline: Task,
	block: ToolUse,
	{
		// askApproval is currently unused for attempt_completion, but kept for API symmetry
		askApproval: _askApproval,
		handleError,
		pushToolResult,
		removeClosingTag,
		toolDescription,
		askFinishSubTaskApproval,
	}: AttemptCompletionCallbacks,
): Promise<ToolResponse | void> {
	const result: string | undefined = (block.params as any).result
	const command: string | undefined = (block.params as any).command

	// Get the setting for preventing completion with open todos from VSCode configuration
	const preventCompletionWithOpenTodos = vscode.workspace
		.getConfiguration(Package.name)
		.get<boolean>("preventCompletionWithOpenTodos", false)

	// Check if there are incomplete todos (only if the setting is enabled)
	const hasIncompleteTodos = cline.todoList && cline.todoList.some((todo) => todo.status !== "completed")

	if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
		cline.consecutiveMistakeCount++
		cline.recordToolError("attempt_completion")

		pushToolResult(
			formatResponse.toolError(
				"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
			),
		)

		return
	}

	try {
		const lastMessage = cline.clineMessages.at(-1)

		if (block.partial) {
			if (command) {
				// The attempt_completion text is done, now we're getting command.
				// Remove the previous partial attempt_completion ask, replace with say,
				// post state to webview, then stream command.

				if (lastMessage && (lastMessage as any).ask === "command") {
					// Update command
					await cline.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
				} else {
					// Last message is completion_result
					// We have command string, which means we have the result as well,
					// so finish it (doesn't have to exist yet)
					await cline.say("completion_result", removeClosingTag("result", result), undefined, false)

					TelemetryService.instance.captureTaskCompleted(cline.taskId)
					cline.emit(RooCodeEventName.TaskCompleted, cline.taskId, cline.getTokenUsage(), cline.toolUsage)

					await cline.ask("command", removeClosingTag("command", command), block.partial).catch(() => {})
				}
			} else {
				// No command, still outputting partial result
				await cline.say("completion_result", removeClosingTag("result", result), undefined, block.partial)
			}
			return
		} else {
			if (!result) {
				cline.consecutiveMistakeCount++
				cline.recordToolError("attempt_completion")
				pushToolResult(await cline.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			cline.consecutiveMistakeCount = 0

			// Command execution is permanently disabled in attempt_completion
			// Users must use execute_command tool separately before attempt_completion
			await cline.say("completion_result", result, undefined, false)
			TelemetryService.instance.captureTaskCompleted(cline.taskId)
			cline.emit(RooCodeEventName.TaskCompleted, cline.taskId, cline.getTokenUsage(), cline.toolUsage)

			if (cline.parentTask) {
				const didApprove = await askFinishSubTaskApproval()

				if (!didApprove) {
					return
				}

				// Tell the provider to remove the current subtask and resume the previous task in the stack
				await cline.providerRef.deref()?.finishSubTask(result)
				return
			}

			// We already sent completion_result says, an
			// empty string asks relinquishes control over
			// button and field.
			const { response, text, images } = await cline.ask("completion_result", "", false)

			// Signals to recursive loop to stop (for now this never happens
			// since yesButtonClicked will trigger a new task).
			if (response === "yesButtonClicked") {
				pushToolResult("")
				return
			}

			await cline.say("user_feedback", text ?? "", images)
			const toolResults: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []

			toolResults.push({
				type: "text",
				text: `The user has provided feedback on the results. Consider their input to continue the task, and then attempt completion again.\n<feedback>\n${text}\n</feedback>`,
			})

			toolResults.push(...formatResponse.imageBlocks(images))
			const labelSuffix = images && images.length > 0 ? " (see image below)" : ""
			cline.userMessageContent.push({ type: "text", text: `${toolDescription()} Result:${labelSuffix}` })
			cline.userMessageContent.push(...toolResults)

			return
		}
	} catch (error) {
		await handleError("inspecting site", error as Error)
		return
	}
}

/**
 * Adapter exported for use by presentAssistantMessage and tests.
 * Matches the common .handle(...) shape used by other tools.
 */
export const attemptCompletionTool = {
	handle: (cline: Task, block: ToolUse, callbacks: AttemptCompletionCallbacks): Promise<ToolResponse | void> => {
		return handleAttemptCompletionInternal(cline, block, callbacks)
	},
}
