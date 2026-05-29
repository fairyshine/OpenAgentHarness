import type { ErrorObject } from "ajv";

const ajv2020Module = await import("ajv/dist/2020.js");
const Ajv2020 = (ajv2020Module.Ajv2020 ?? ajv2020Module.default) as typeof import("ajv/dist/2020.js")["Ajv2020"];
const addFormats = (await import("ajv-formats")).default as unknown as typeof import("ajv-formats").default;

export function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false
  });

  addFormats(ajv);
  return ajv;
}

function expandEnvInString(input: string): string {
  return input.replaceAll(/\$\{env\.([A-Z0-9_]+)\}/gi, (_match, envName: string) => {
    const value = process.env[envName];
    if (value === undefined) {
      throw new Error(`Environment variable ${envName} is required but not set.`);
    }

    return value;
  });
}

export function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    return expandEnvInString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnv(item)) as T;
  }

  if (value && typeof value === "object") {
    const expandedEntries = Object.entries(value).map(([key, nestedValue]) => [key, expandEnv(nestedValue)]);
    return Object.fromEntries(expandedEntries) as T;
  }

  return value;
}

export function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") ?? "unknown schema validation error";
}
