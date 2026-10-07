/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- the OpenAPI document is untyped YAML */
import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

/*
 * Frozen-contract conformance for HTTP tests: validates request bodies and
 * responses against docs/v2/openapi.yaml with the same AJV setup as the
 * contract validator (docs/v2/tools/validate-contract.mjs: Ajv 2020,
 * ajv-formats, the whole document registered as `oas`). Schemas are used
 * exactly as frozen; nothing is relaxed.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const document = parse(fs.readFileSync(path.resolve("docs/v2/openapi.yaml"), "utf8")) as Json;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(document, "oas");

function pointer(ref: string): string {
  return ref.replace(/^#/, "");
}

function resolve(node: Json): Json {
  if (typeof node.$ref !== "string") {
    return node;
  }

  return pointer(node.$ref)
    .split("/")
    .slice(1)
    .reduce((value: Json, key: string): Json => value[key.replace(/~1/g, "/")], document);
}

function check(ref: string, value: unknown): string[] {
  const validate = ajv.getSchema(`oas${ref}`) ?? ajv.compile({ $ref: `oas${ref}` });
  return validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`.trim());
}

/** Errors of `value` against `components/schemas/<name>` (empty when valid). */
export function schemaErrors(name: string, value: unknown): string[] {
  return check(`#/components/schemas/${name}`, value);
}

/** Errors of a JSON response body against the frozen operation response for `status`. */
export function responseErrors(pathTemplate: string, method: string, status: number, body: unknown): string[] {
  const operation = document.paths[pathTemplate]?.[method.toLowerCase()];

  if (!operation) {
    return [`no operation ${method} ${pathTemplate} in openapi.yaml`];
  }

  const declared = operation.responses[String(status)];

  if (!declared) {
    return [`status ${status} is not declared for ${method} ${pathTemplate}`];
  }

  const response = resolve(declared);
  const schema = response.content?.["application/json"]?.schema;

  if (!schema) {
    return [`status ${status} of ${method} ${pathTemplate} has no JSON body`];
  }

  if (typeof schema.$ref === "string") {
    return check(schema.$ref, body);
  }

  const validate = ajv.compile(schema);
  return validate(body) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`.trim());
}

/** Declared header names (lowercase) of a frozen operation response. */
export function declaredResponseHeaders(pathTemplate: string, method: string, status: number): string[] {
  const response = resolve(document.paths[pathTemplate][method.toLowerCase()].responses[String(status)]);
  return Object.keys(response.headers ?? {}).map((name) => name.toLowerCase());
}

/** `x-required-scopes` of a frozen operation. */
export function requiredScopes(pathTemplate: string, method: string): string[] {
  return (document.paths[pathTemplate][method.toLowerCase()]["x-required-scopes"] as string[] | undefined) ?? [];
}
