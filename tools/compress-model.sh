#!/bin/sh
# Compress the Blender export (models-src/legs.glb, 2.5 MB) into the served model web/models/legs.glb
# (Draco, about 330 KB). Draco decodes back to the original coordinates, which the stocking code reads
# directly; 16-bit positions and UVs are about 0.014 mm and 0.0001 rad apart, far finer than the 4 mm
# rings. (meshopt's quantisation would instead move positions and UVs into another space.)
# The decoder the page loads is three's, copied into web/vendor/three/jsm/libs/draco/gltf/.
set -e
cd "$(dirname "$0")/.."
npx gltf-transform draco models-src/legs.glb web/models/legs.glb \
  --quantize-position 16 --quantize-texcoord 16 --quantize-normal 12
