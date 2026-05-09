import type { AskUserQuestionPrompt, AskUserQuestionSelection, ChatLine } from "./types.js";
import { clampIndex } from "./formatting.js";
import { isRecord, readString } from "./tool-output.js";

export function readAskUserQuestionPrompt(toolName: string, output: unknown): AskUserQuestionPrompt | undefined {
  if (toolName !== "AskUserQuestion" || !isRecord(output) || output.type !== "json" || !isRecord(output.value)) {
    return undefined;
  }
  if (output.value.status !== "awaiting_user" || !Array.isArray(output.value.questions)) {
    return undefined;
  }

  const questions = output.value.questions.flatMap((rawQuestion) => {
    if (!isRecord(rawQuestion)) {
      return [];
    }
    const question = readString(rawQuestion.question);
    if (!question) {
      return [];
    }
    const options = Array.isArray(rawQuestion.options)
      ? rawQuestion.options.flatMap((rawOption) => {
          if (!isRecord(rawOption)) {
            return [];
          }
          const label = readString(rawOption.label);
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description: readString(rawOption.description)
            }
          ];
        })
      : undefined;
    return [
      {
        question,
        header: readString(rawQuestion.header),
        ...(options && options.length > 0 ? { options } : {}),
        ...(typeof rawQuestion.multiSelect === "boolean" ? { multiSelect: rawQuestion.multiSelect } : {}),
        ...(typeof rawQuestion.freeText === "boolean" ? { freeText: rawQuestion.freeText } : {})
      }
    ];
  });

  return questions.length > 0 ? { questions } : undefined;
}

export function formatAskUserQuestionPrompt(prompt: AskUserQuestionPrompt) {
  const lines = ["User input needed"];
  prompt.questions.forEach((question, questionIndex) => {
    const prefix = prompt.questions.length > 1 ? `${questionIndex + 1}. ` : "";
    lines.push(`${prefix}${question.header ? `[${question.header}] ` : ""}${question.question}`);
    question.options?.forEach((option, optionIndex) => {
      lines.push(`  ${optionIndex + 1}) ${option.label}${option.description ? ` - ${option.description}` : ""}`);
    });
    const hint = question.multiSelect ? "Enter option numbers separated by commas, or type a custom answer." : "Enter an option number, or type a custom answer.";
    lines.push(`  ${hint}`);
  });
  return lines.join("\n");
}

export function latestAskUserQuestionPrompt(lines: ChatLine[]): AskUserQuestionPrompt | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.role === "user") {
      return undefined;
    }
    if (line?.askUserQuestion) {
      return line.askUserQuestion;
    }
  }
  return undefined;
}

export function askUserQuestionPromptKey(prompt: AskUserQuestionPrompt) {
  return prompt.questions.map((question) => question.question).join("\n");
}

export function createAskUserQuestionSelection(prompt: AskUserQuestionPrompt): AskUserQuestionSelection {
  return {
    promptKey: askUserQuestionPromptKey(prompt),
    questionIndex: 0,
    optionIndex: 0,
    selectedByQuestion: {}
  };
}

export function isAskUserQuestionSelectionCurrent(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection | null | undefined) {
  return selection?.promptKey === askUserQuestionPromptKey(prompt);
}

export function moveAskUserQuestionSelection(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection, delta: number) {
  const question = prompt.questions[selection.questionIndex];
  const optionCount = Math.max(1, question?.options?.length ?? 1);
  return {
    ...selection,
    optionIndex: clampIndex(selection.optionIndex + delta, optionCount)
  };
}

export function moveAskUserQuestionQuestion(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection, delta: number) {
  const questionIndex = clampIndex(selection.questionIndex + delta, prompt.questions.length);
  const question = prompt.questions[questionIndex];
  const optionCount = Math.max(1, question?.options?.length ?? 1);
  return {
    ...selection,
    questionIndex,
    optionIndex: Math.min(selection.optionIndex, optionCount - 1)
  };
}

export function toggleAskUserQuestionSelection(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection) {
  const question = prompt.questions[selection.questionIndex];
  const option = question?.options?.[selection.optionIndex];
  if (!question || !option) {
    return selection;
  }

  const current = selection.selectedByQuestion[selection.questionIndex] ?? [];
  const next = question.multiSelect
    ? current.includes(option.label)
      ? current.filter((item) => item !== option.label)
      : [...current, option.label]
    : [option.label];

  return {
    ...selection,
    selectedByQuestion: {
      ...selection.selectedByQuestion,
      [selection.questionIndex]: next
    }
  };
}

export function selectFocusedAskUserQuestionOption(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection) {
  const question = prompt.questions[selection.questionIndex];
  if (question?.multiSelect) {
    return selection;
  }
  const option = question?.options?.[selection.optionIndex];
  if (!question || !option) {
    return selection;
  }
  return {
    ...selection,
    selectedByQuestion: {
      ...selection.selectedByQuestion,
      [selection.questionIndex]: [option.label]
    }
  };
}

export function formatAskUserQuestionSelectionAnswer(prompt: AskUserQuestionPrompt, selection: AskUserQuestionSelection) {
  const answers = prompt.questions.map((question, index) => {
    const selected = selection.selectedByQuestion[index] ?? [];
    return selected.length > 0 ? selected.join(", ") : "";
  });

  return `Answers to your questions:\n${prompt.questions
    .map((question, index) => `${index + 1}. ${question.question} ${answers[index]?.trim() || "(no answer)"}`)
    .join("\n")}`;
}

export function formatAskUserQuestionAnswer(prompt: AskUserQuestionPrompt, rawAnswer: string) {
  const trimmed = rawAnswer.trim();
  if (!trimmed) {
    return "";
  }

  if (prompt.questions.length === 1) {
    const question = prompt.questions[0]!;
    const selected = resolveAskUserQuestionSelection(question.options, trimmed, question.multiSelect === true);
    const answer = selected.length > 0 ? selected.join(", ") : trimmed;
    return `Answers to your questions:\n1. ${question.question} ${answer}`;
  }

  return `Answers to your questions:\n${trimmed}`;
}

function resolveAskUserQuestionSelection(options: { label: string }[] | undefined, rawAnswer: string, multiSelect: boolean) {
  if (!options || options.length === 0) {
    return [];
  }
  const parts = multiSelect ? rawAnswer.split(/[,\s]+/u) : [rawAnswer];
  const selected = parts
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= options.length)
    .map((value) => options[value - 1]?.label)
    .filter((value): value is string => typeof value === "string");
  return [...new Set(selected)];
}
