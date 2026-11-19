# tarea-argocd · Red Hat Developer Hub con Argo CD (GitOps)

Despliegue automatizado de **Red Hat Developer Hub** (portal de desarrolladores basado en Backstage) en Kubernetes,
usando **Argo CD** y este repositorio como fuente de verdad.
Argo CD vigila la carpeta `manifests/` y aplica cada commit en el clúster con sincronización automática.

## Estructura

```
manifests/            ← carpeta que sincroniza Argo CD
  configmap.yml       app-config de Developer Hub y catálogo de ejemplo
  deployment.yml      2 réplicas, labels/selectors, requests/limits, puerto 7007
  service.yml         NodePort 30700 → targetPort 7007
  hpa.yml             autoscaling/v2: 2 a 5 réplicas al 50 % de CPU
  postgres.yml        PostgreSQL compartido (Secret, PVC, Deployment, Service ClusterIP)
argocd/
  application.yml     Application de Argo CD con Automated Sync (prune + selfHeal)
scripts/
  generar-carga.sh    genera tráfico dentro del clúster para probar el HPA
```

## Entorno

| Elemento | Valor |
|---|---|
| Clúster | Talos Linux v1.14.5 sobre QEMU (1 control plane + 1 worker, arm64) |
| Kubernetes | v1.37.1 |
| Metrics Server | instalado en `kube-system` (requisito del HPA) |
| GitOps | Argo CD en el namespace `argocd` |
| Imagen | `quay.io/rhdh-community/rhdh:1.10.7` (build comunitario multi-arch de Red Hat Developer Hub) |

## Recursos

**Deployment** `developer-hub`: 2 réplicas iniciales, selector `app: developer-hub`,
`requests` 200m CPU / 320Mi y `limits` 500m CPU / 512Mi, `containerPort` 7007, probes de readiness y liveness
y securityContext compatible con el perfil *restricted*.

**Service** `developer-hub`: tipo `NodePort`, `port` 80 → `targetPort` 7007, `nodePort` 30700,
asociado a los Pods con el selector `app: developer-hub`.

**HPA** `developer-hub`: `minReplicas` 2, `maxReplicas` 5 y objetivo de 50 % de CPU (100m por Pod sobre los 200m pedidos).

**PostgreSQL** `postgres`: base común para todas las réplicas. Guarda el catálogo y las claves con que se firman
las sesiones, así cualquier réplica valida el token emitido por otra y Developer Hub puede escalar sin estado.
Las credenciales del Secret son de laboratorio: la base solo se expone dentro del clúster.

**Application** `developer-hub`: apunta a `manifests/` en la rama `main`, crea el namespace `developer-hub`
y tiene `automated` con `prune` y `selfHeal`. Ignora `/spec/replicas` del Deployment para que el HPA y Argo CD no se peleen.

## Uso

```bash
# 1. Registrar la aplicación en Argo CD (una sola vez)
kubectl apply -f argocd/application.yml

# 2. Ver el estado
kubectl -n argocd get application developer-hub
kubectl -n developer-hub get deploy,svc,hpa,pods

# 3. Abrir Developer Hub
open http://10.5.0.3:30700

# 4. Probar el autoescalado
bash scripts/generar-carga.sh 240 12
kubectl -n developer-hub get hpa developer-hub -w
```

## Problemas resueltos durante el despliegue

| Síntoma | Causa | Solución |
|---|---|---|
| Página en blanco, `ERR_SSL_PROTOCOL_ERROR` en el navegador | La CSP de Backstage incluye `upgrade-insecure-requests` y el NodePort sirve HTTP | `backend.csp.upgrade-insecure-requests: false` |
| `401 Unauthorized` intermitente con 2 réplicas | SQLite en memoria: cada réplica firmaba sesiones con su propia clave | PostgreSQL compartido |
| Al escalar a 5, las réplicas nuevas no quedaban Ready | PostgreSQL OOMKilled con límite de 256Mi (~18 conexiones por réplica) | Límite 512Mi, `max_connections=150`, pool de 3 por plugin |

Cualquier cambio en `manifests/` que se suba a `main` lo aplica Argo CD solo, sin `kubectl apply`.
