import { writeFileSync } from "node:fs"
import { stringify } from "yaml"
import app from "./index.js"
import { createDoc } from "./doc.js"

const doc = createDoc(app)
const yaml = stringify(doc, { lineWidth: 120 })
writeFileSync("dist/openapi.yaml", yaml)
console.log("Wrote dist/openapi.yaml")
