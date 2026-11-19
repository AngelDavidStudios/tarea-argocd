#!/usr/bin/env bash
# Genera carga HTTP contra Developer Hub desde dentro del clúster para que el HPA escale.
# Uso: bash scripts/generar-carga.sh [segundos] [hilos]   (por defecto 240 s y 12 hilos)
set -euo pipefail

DURACION="${1:-240}"
HILOS="${2:-12}"
URL="http://developer-hub.developer-hub.svc.cluster.local"

kubectl -n developer-hub delete pod generador-carga --ignore-not-found --wait=true >/dev/null
kubectl -n developer-hub run generador-carga --image=busybox:1.37 --restart=Never -- \
  sh -c "for i in \$(seq ${HILOS}); do (while true; do wget -q -O /dev/null ${URL}/; wget -q -O /dev/null ${URL}/api/catalog/entities 2>/dev/null; done) & done; sleep ${DURACION}"

echo "Carga en marcha durante ${DURACION}s. Observa con: kubectl -n developer-hub get hpa -w"
