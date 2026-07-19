import { z, type RefinementCtx } from "zod";

import {
  strictObjectOpenApiSchema,
  type OpenApiSchema,
} from "./openapi.js";
import { CONTENT_ID_PATTERN, contentIdSchema } from "./shares.js";

export const SPACE_DISCOVERY_QUERY_MAX_LENGTH = 512;
export const SPACE_DISCOVERY_BLOCK_CONTENT_MAX_LENGTH = 4096;
export const SPACE_DISCOVERY_GRAPH_LABEL_MAX_LENGTH = 512;
export const SPACE_DISCOVERY_MAX_SEARCH_BLOCKS = 64;
export const SPACE_DISCOVERY_MAX_GRAPH_NODES = 2048;
export const SPACE_DISCOVERY_MAX_GRAPH_LINKS = 4096;

function unicodeCodePointStringSchema(maximum: number, minimum = 0) {
  return z.string().superRefine((value, context) => {
    const length = Array.from(value).length;
    if (length < minimum || length > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `String must contain ${minimum} to ${maximum} Unicode code points`,
      });
    }
  });
}

function requireProjectedGraphEndpoints(
  graph: {
    readonly links: readonly { readonly from: string; readonly to: string }[];
    readonly nodes: readonly { readonly id: string }[];
  },
  context: RefinementCtx,
): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  graph.links.forEach((link, index) => {
    if (!nodeIds.has(link.from) || !nodeIds.has(link.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Graph links must connect projected nodes",
        path: ["links", index],
      });
    }
  });
}

export const spaceDiscoverySearchMethods = ["keyword", "preferred"] as const;
export const spaceDiscoverySearchMethodSchema = z.enum(
  spaceDiscoverySearchMethods,
);
export type SpaceDiscoverySearchMethod = z.infer<
  typeof spaceDiscoverySearchMethodSchema
>;

export const spaceDiscoveryQuerySchema = unicodeCodePointStringSchema(
  SPACE_DISCOVERY_QUERY_MAX_LENGTH,
);

export const spaceDiscoverySearchRequestSchema = z
  .object({
    method: spaceDiscoverySearchMethodSchema,
    query: spaceDiscoveryQuerySchema,
  })
  .strict();
export type SpaceDiscoverySearchRequest = z.infer<
  typeof spaceDiscoverySearchRequestSchema
>;

export const spaceDiscoveryGraphRequestSchema = z
  .object({ query: spaceDiscoveryQuerySchema })
  .strict();
export type SpaceDiscoveryGraphRequest = z.infer<
  typeof spaceDiscoveryGraphRequestSchema
>;

export const spaceDiscoveryBlockSchema = z
  .object({
    content: unicodeCodePointStringSchema(
      SPACE_DISCOVERY_BLOCK_CONTENT_MAX_LENGTH,
    ),
    documentId: contentIdSchema,
    id: contentIdSchema,
    notebookId: contentIdSchema,
  })
  .strict();
export type SpaceDiscoveryBlock = z.infer<typeof spaceDiscoveryBlockSchema>;

export const spaceDiscoverySearchResponseSchema = z
  .object({
    blocks: z
      .array(spaceDiscoveryBlockSchema)
      .max(SPACE_DISCOVERY_MAX_SEARCH_BLOCKS),
    matchedBlockCount: z.number().int().min(0),
    pageCount: z.number().int().min(0),
  })
  .strict();
export type SpaceDiscoverySearchResponse = z.infer<
  typeof spaceDiscoverySearchResponseSchema
>;

export const spaceDiscoveryGraphNodeSchema = z
  .object({
    documentId: contentIdSchema,
    id: contentIdSchema,
    label: unicodeCodePointStringSchema(
      SPACE_DISCOVERY_GRAPH_LABEL_MAX_LENGTH,
      1,
    ),
    notebookId: contentIdSchema,
  })
  .strict();
export type SpaceDiscoveryGraphNode = z.infer<
  typeof spaceDiscoveryGraphNodeSchema
>;

export const spaceDiscoveryGraphLinkSchema = z
  .object({ from: contentIdSchema, to: contentIdSchema })
  .strict();
export type SpaceDiscoveryGraphLink = z.infer<
  typeof spaceDiscoveryGraphLinkSchema
>;

export const spaceDiscoveryGraphResponseSchema = z
  .object({
    links: z
      .array(spaceDiscoveryGraphLinkSchema)
      .max(SPACE_DISCOVERY_MAX_GRAPH_LINKS),
    nodes: z
      .array(spaceDiscoveryGraphNodeSchema)
      .max(SPACE_DISCOVERY_MAX_GRAPH_NODES),
  })
  .strict()
  .superRefine(requireProjectedGraphEndpoints);
export type SpaceDiscoveryGraphResponse = z.infer<
  typeof spaceDiscoveryGraphResponseSchema
>;

export const documentDiscoveryBacklinkSchema = z
  .object({
    documentId: contentIdSchema,
    notebookId: contentIdSchema,
    title: unicodeCodePointStringSchema(
      SPACE_DISCOVERY_GRAPH_LABEL_MAX_LENGTH,
      1,
    ),
  })
  .strict();
export type DocumentDiscoveryBacklink = z.infer<
  typeof documentDiscoveryBacklinkSchema
>;

export const documentDiscoveryBacklinksDataSchema = z
  .object({
    backlinks: z.array(documentDiscoveryBacklinkSchema),
    backmentions: z.array(documentDiscoveryBacklinkSchema),
  })
  .strict();
export type DocumentDiscoveryBacklinksData = z.infer<
  typeof documentDiscoveryBacklinksDataSchema
>;

export const documentDiscoveryHistoryDataSchema = z
  .object({
    histories: z.array(z.string()),
    pageCount: z.number().int().min(0),
    totalCount: z.number().int().min(0),
  })
  .strict();
export type DocumentDiscoveryHistoryData = z.infer<
  typeof documentDiscoveryHistoryDataSchema
>;

export interface DocumentDiscoveryOutlineItem {
  children: DocumentDiscoveryOutlineItem[];
  id: string;
  name: string;
}

export const documentDiscoveryOutlineItemSchema:
  z.ZodType<DocumentDiscoveryOutlineItem> = z.lazy(() =>
    z
      .object({
        children: z.array(documentDiscoveryOutlineItemSchema),
        id: contentIdSchema,
        name: unicodeCodePointStringSchema(
          SPACE_DISCOVERY_GRAPH_LABEL_MAX_LENGTH,
        ),
      })
      .strict()
  );

export const documentDiscoveryOutlineDataSchema = z.array(
  documentDiscoveryOutlineItemSchema,
);

const documentDiscoveryGraphNodeIdSchema = unicodeCodePointStringSchema(
  SPACE_DISCOVERY_GRAPH_LABEL_MAX_LENGTH,
  1,
);

export const documentDiscoveryGraphNodeSchema = z
  .object({
    documentId: contentIdSchema.nullable(),
    id: documentDiscoveryGraphNodeIdSchema,
    label: unicodeCodePointStringSchema(
      SPACE_DISCOVERY_GRAPH_LABEL_MAX_LENGTH,
      1,
    ),
    notebookId: contentIdSchema.nullable(),
  })
  .strict()
  .superRefine((node, context) => {
    if ((node.documentId === null) !== (node.notebookId === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Document graph navigation identity must be complete",
      });
    }
  });
export type DocumentDiscoveryGraphNode = z.infer<
  typeof documentDiscoveryGraphNodeSchema
>;

export const documentDiscoveryGraphLinkSchema = z
  .object({
    from: documentDiscoveryGraphNodeIdSchema,
    to: documentDiscoveryGraphNodeIdSchema,
  })
  .strict();
export type DocumentDiscoveryGraphLink = z.infer<
  typeof documentDiscoveryGraphLinkSchema
>;

export const documentDiscoveryGraphDataSchema = z
  .object({
    links: z
      .array(documentDiscoveryGraphLinkSchema)
      .max(SPACE_DISCOVERY_MAX_GRAPH_LINKS),
    nodes: z
      .array(documentDiscoveryGraphNodeSchema)
      .max(SPACE_DISCOVERY_MAX_GRAPH_NODES),
  })
  .strict()
  .superRefine(requireProjectedGraphEndpoints);
export type DocumentDiscoveryGraphData = z.infer<
  typeof documentDiscoveryGraphDataSchema
>;

const CONTENT_ID_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  pattern: CONTENT_ID_PATTERN.source,
};

const SPACE_DISCOVERY_QUERY_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  maxLength: SPACE_DISCOVERY_QUERY_MAX_LENGTH,
};

const SPACE_DISCOVERY_METHOD_OPENAPI_SCHEMA: OpenApiSchema = {
  type: "string",
  enum: [...spaceDiscoverySearchMethods],
};

export const SPACE_DISCOVERY_SEARCH_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    method: SPACE_DISCOVERY_METHOD_OPENAPI_SCHEMA,
    query: SPACE_DISCOVERY_QUERY_OPENAPI_SCHEMA,
  });

export const SPACE_DISCOVERY_GRAPH_REQUEST_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({ query: SPACE_DISCOVERY_QUERY_OPENAPI_SCHEMA });

export const SPACE_DISCOVERY_BLOCK_OPENAPI_SCHEMA = strictObjectOpenApiSchema({
  content: {
    type: "string",
    maxLength: SPACE_DISCOVERY_BLOCK_CONTENT_MAX_LENGTH,
  },
  documentId: CONTENT_ID_OPENAPI_SCHEMA,
  id: CONTENT_ID_OPENAPI_SCHEMA,
  notebookId: CONTENT_ID_OPENAPI_SCHEMA,
});

export const SPACE_DISCOVERY_SEARCH_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    blocks: {
      type: "array",
      items: SPACE_DISCOVERY_BLOCK_OPENAPI_SCHEMA,
      maxItems: SPACE_DISCOVERY_MAX_SEARCH_BLOCKS,
    },
    matchedBlockCount: { type: "integer", minimum: 0 },
    pageCount: { type: "integer", minimum: 0 },
  });

export const SPACE_DISCOVERY_GRAPH_NODE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    documentId: CONTENT_ID_OPENAPI_SCHEMA,
    id: CONTENT_ID_OPENAPI_SCHEMA,
    label: {
      type: "string",
      minLength: 1,
      maxLength: SPACE_DISCOVERY_GRAPH_LABEL_MAX_LENGTH,
    },
    notebookId: CONTENT_ID_OPENAPI_SCHEMA,
  });

export const SPACE_DISCOVERY_GRAPH_LINK_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    from: CONTENT_ID_OPENAPI_SCHEMA,
    to: CONTENT_ID_OPENAPI_SCHEMA,
  });

export const SPACE_DISCOVERY_GRAPH_RESPONSE_OPENAPI_SCHEMA =
  strictObjectOpenApiSchema({
    links: {
      type: "array",
      items: SPACE_DISCOVERY_GRAPH_LINK_OPENAPI_SCHEMA,
      maxItems: SPACE_DISCOVERY_MAX_GRAPH_LINKS,
    },
    nodes: {
      type: "array",
      items: SPACE_DISCOVERY_GRAPH_NODE_OPENAPI_SCHEMA,
      maxItems: SPACE_DISCOVERY_MAX_GRAPH_NODES,
    },
  });
