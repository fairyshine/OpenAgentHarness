import type { ErrorObject, ValidateFunction } from "ajv";

import { AppError } from "../errors.js";
import type { ActionDefinition } from "../types.js";

const ajv2020Module = await import("ajv/dist/2020.js");
const Ajv2020 = (ajv2020Module.Ajv2020 ?? ajv2020Module.default) as typeof import("ajv/dist/2020.js")["Ajv2020"];
const addFormats = (await import("ajv-formats")).default as unknown as typeof import("ajv-formats").default;

const validatorCache = new WeakMap<Record<string, unknown>, ValidateFunction<unknown>>();

function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false
  });

  addFormats(ajv);
  return ajv;
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "Input does not match the declared schema.";
  }

  return errors
    .map((error) => {
      const location = error.instancePath || "/";
      return `${location} ${error.message ?? "is invalid"}`.trim();
    })
    .join("; ");
}

function schemaValidator(schema: Record<string, unknown>) {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  const validate = createAjv().compile<unknown>(schema);
  validatorCache.set(schema, validate);
  return validate;
}

export function validateActionInput(action: Pick<ActionDefinition, "name" | "inputSchema">, input: unknown): void {
  if (!action.inputSchema) {
    return;
  }

  const validate = schemaValidator(action.inputSchema);
  if (validate(input)) {
    return;
  }

  throw new AppError(
    400,
    "action_input_invalid",
    `Input for action ${action.name} is invalid: ${validationMessage(validate.errors)}`
  );
}
