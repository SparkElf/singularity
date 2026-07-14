export interface OpenApiSchema {
  additionalProperties?: boolean;
  enum?: Array<number | string>;
  format?: string;
  items?: OpenApiSchema;
  maxItems?: number;
  maxLength?: number;
  minItems?: number;
  minLength?: number;
  oneOf?: OpenApiSchema[];
  pattern?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  type?: "array" | "integer" | "number" | "object" | "string";
}

export const UUID_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  format: "uuid",
};

export function strictObjectOpenApiSchema(
  properties: Record<string, OpenApiSchema>,
  required: string[] = Object.keys(properties),
): OpenApiSchema {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}
