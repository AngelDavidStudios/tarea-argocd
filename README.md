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
  postgres.yml        PostgreSQL compartido (PVC, Deployment, Service ClusterIP)
  postgres-sealedsecret.yml   credenciales de PostgreSQL cifradas con Sealed Secrets
argocd/
  application.yml     Application de Argo CD con Automated Sync (prune + selfHeal)
  sealed-secrets.yml  Application que instala el controlador de Sealed Secrets en kube-system
scripts/
  generar-carga.sh    genera tráfico dentro del clúster para probar el HPA
pruebas/k6/
  usuarios-developer-hub.js   prueba de carga k6: hasta 200 usuarios virtuales por el NodePort
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
Las credenciales no están en el repositorio en texto plano: ver «Secretos con Sealed Secrets».

**Application** `developer-hub`: apunta a `manifests/` en la rama `main`, crea el namespace `developer-hub`
y tiene `automated` con `prune` y `selfHeal`. Ignora `/spec/replicas` del Deployment para que el HPA y Argo CD no se peleen.

## Uso

```bash
# 1. Registrar las aplicaciones en Argo CD (una sola vez)
kubectl apply -f argocd/sealed-secrets.yml
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

## Secretos con Sealed Secrets

Un `Secret` de Kubernetes solo codifica sus valores en base64, así que no puede subirse a un repositorio público.
Las credenciales de PostgreSQL se guardan como `SealedSecret` (`manifests/postgres-sealedsecret.yml`): están
cifradas con la clave pública del controlador de Sealed Secrets y solo el clúster puede descifrarlas.
Argo CD aplica el `SealedSecret` y el controlador crea el `Secret` `credenciales-postgres`, que leen
PostgreSQL y Developer Hub con `envFrom.secretRef`.

```bash
brew install kubeseal
# Volver a generar el SealedSecret (por ejemplo, para rotar la contraseña)
kubectl -n developer-hub create secret generic credenciales-postgres \
  --from-literal=POSTGRES_USER=rhdh --from-literal=POSTGRES_PASSWORD="$PG_PASSWORD" \
  --dry-run=client -o yaml | kubeseal --format yaml > manifests/postgres-sealedsecret.yml
```

Si se recrea el clúster, la clave privada del controlador cambia y hay que volver a cifrar las credenciales.

## Prueba de carga con k6

`pruebas/k6/usuarios-developer-hub.js` simula usuarios reales que entran a Developer Hub por el NodePort
(como lo haría un navegador desde fuera del clúster): cada usuario virtual inicia sesión como invitado,
abre el catálogo, consulta un componente y hace una búsqueda, con pausas de 1 a 3 s entre pasos.

| Etapa | Duración | Usuarios virtuales |
|---|---|---|
| Calentamiento | 30 s | 0 → 10 |
| Llegan más usuarios | 1 min | 10 → 100 |
| Hora pico | 1 min | 100 → 200 |
| Se mantiene el pico | 3 min | 200 |
| Los usuarios se van | 1 min | 200 → 0 |

Umbrales: menos de 5 % de peticiones fallidas, más de 95 % de checks correctos y p95 de la API por debajo de 3 s.

```bash
brew install k6
K6_WEB_DASHBOARD=true k6 run pruebas/k6/usuarios-developer-hub.js   # dashboard en http://localhost:5665
PICO=100 BASE_URL=http://10.5.0.3:30700 k6 run pruebas/k6/usuarios-developer-hub.js
```

Mientras corre, el HPA sube las réplicas y Argo CD muestra los Pods nuevos en el árbol de la aplicación.

## Problemas resueltos durante el despliegue

| Síntoma | Causa | Solución |
|---|---|---|
| Página en blanco, `ERR_SSL_PROTOCOL_ERROR` en el navegador | La CSP de Backstage incluye `upgrade-insecure-requests` y el NodePort sirve HTTP | `backend.csp.upgrade-insecure-requests: false` |
| `401 Unauthorized` intermitente con 2 réplicas | SQLite en memoria: cada réplica firmaba sesiones con su propia clave | PostgreSQL compartido |
| Contraseña de PostgreSQL legible en el repositorio público | Un `Secret` solo codifica en base64 | `SealedSecret` cifrado y contraseña rotada |
| Al escalar a 5, las réplicas nuevas no quedaban Ready | PostgreSQL OOMKilled con límite de 256Mi (~18 conexiones por réplica) | Límite 512Mi, `max_connections=150`, pool de 3 por plugin |

Cualquier cambio en `manifests/` que se suba a `main` lo aplica Argo CD solo, sin `kubectl apply`.
