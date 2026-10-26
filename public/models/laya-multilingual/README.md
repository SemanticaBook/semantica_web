---
license: apache-2.0
base_model: convaiinnovations/laya/multilingual
library_name: onnx
tags: [onnx, onnxruntime-web, browser, decision-model, quantized]
---
# multilingual converted for the browser

This is a modified copy of the checkpoint at [convaiinnovations/laya/multilingual](https://huggingface.co/convaiinnovations/laya/multilingual)
(Apache-2.0, Copyright ConvAI Innovations), made for ONNX Runtime Web. It is unofficial and not affiliated with
ConvAI Innovations. This is the multilingual mmBERT-base checkpoint from the `multilingual/` subdirectory, prepared for book structure classification in Semantica. The upstream multilingual model is based on mmBERT-base
(Apache-2.0).

**Changes from the original:** exported to ONNX; weights quantized (weight-only int8 or int4, int8 embeddings), so
outputs differ slightly from the original PyTorch model; weight files split into parts (`*.onnx.data.partNNN`, listed
in `manifest.json`, which the demo page reassembles).

Licensed under the Apache License, Version 2.0. See `LICENSE` and `NOTICE.md` in this folder.
Build scripts and demo: the `layaForWeb` repository that produced this folder.

This is a quantized browser artifact, not the original checkpoint. It was built for local ONNX Runtime WebAssembly inference in the Semantica book converter. Refer to `NOTICE.md` and `LICENSE` for attribution and terms.
