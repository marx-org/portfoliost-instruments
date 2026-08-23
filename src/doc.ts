import { createOpenApiDocument } from "hono-zod-openapi"
import type { Hono } from "hono"

export function createDoc(app: Hono) {
  return createOpenApiDocument(app, {
    info: {
      title: "Portfoliost API",
      version: "1.0.0",
    },
  }) as any // eslint-disable-line @typescript-eslint/no-explicit-any
}
