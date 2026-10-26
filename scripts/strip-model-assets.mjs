import { rmSync } from "node:fs";
import { resolve } from "node:path";

// A locally prepared model may exist under public/ for development, but model
// weights are distributed separately and must never enter the Pages artifact.
rmSync(resolve("dist/models/laya-multilingual"), { recursive: true, force: true });
