# Ambient Provider Helm Chart

Deploy NVIDIA Ambient Provider on OpenShift using cloud NIMs.

## Prerequisites

1. **Images built** (see [../README.md](../README.md) — Build images on OpenShift)
   ```bash
   ./openshift/build-images.sh
   ```

2. **NVIDIA API Key** from https://build.nvidia.com/ (ensure **Cloud Functions** is included in key scopes if using cloud Riva)

3. **Riva function ID** (for cloud Riva). See [Get Riva function ID](#get-riva-function-id) below.

4. **OpenShift cluster** with access

## Quick Start

```bash
# Install with API key and Riva function ID (required for cloud Riva)
helm install ambient-provider ./openshift/ambient-provider \
  --namespace fax \
  --set nvidia.apiKey='nvapi-your-key-here' \
  --set nvidia.rivaFunctionId='<your-riva-function-id>'

# Get the URL
oc get route ambient-provider-ambient-provider -n fax -o jsonpath='{.spec.host}'
```

## Configuration

### Basic Configuration

```bash
helm install ambient-provider ./openshift/ambient-provider \
  --namespace fax \
  --set nvidia.apiKey='nvapi-xxx' \
  --set images.namespace=fax
```

### With Custom Values

Create `my-values.yaml`:
```yaml
nvidia:
  apiKey: "nvapi-your-key-here"

images:
  namespace: fax  # Where images were built

replicaCount:
  api: 2
  ui: 2
```

Install:
```bash
helm install ambient-provider ./openshift/ambient-provider \
  --namespace fax \
  -f my-values.yaml
```

## Values Reference

| Parameter | Description | Default |
|-----------|-------------|---------|
| `nvidia.apiKey` | NVIDIA API key (for cloud LLM; also for NVCF Riva if not self-hosted) | `""` |
| `nvidia.selfHostedRiva` | If true, Riva runs in your cluster. If false, use NVCF (requires `rivaFunctionId`). | `false` |
| `nvidia.rivaUri` | Riva gRPC address. Cloud: `grpc.nvcf.nvidia.com:443`; self-hosted: in-cluster service. | `grpc.nvcf.nvidia.com:443` |
| `nvidia.rivaFunctionId` | **Required for cloud Riva.** Exposed as `RIVA_FUNCTION_ID`. List public/authorized functions (see below) or deploy Riva in NGC Cloud Functions. | `""` |
| `nvidia.llmEndpoint` | Cloud LLM endpoint | `https://integrate.api.nvidia.com/v1` |
| `images.namespace` | Namespace where images were built | `fax` |
| `route.enabled` | Create OpenShift Route | `true` |
| `replicaCount.api` | API replicas | `1` |
| `ui.viteUseStreaming` | Sets pod env `VITE_USE_STREAMING` for the Vite UI (`true` / `false`) | `false` |

## Get Riva function ID

Cloud Riva (NVCF) requires a **function ID**. You can get one in two ways:

**Option A – Use a public/authorized function**  
List functions your API key can use (key must have *Cloud Functions* scope, e.g. from https://org.ngc.nvidia.com/setup/api-keys):

```bash
curl -s -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public&visibility=authorized" | jq '.functions[] | {id, name}'
```

Pick a Riva ASR function (name may contain "Riva", "ASR", or "Parakeet") and use its `id` as `nvidia.rivaFunctionId`.

**Option B – Deploy your own**  
In [NGC Cloud Functions](https://ngc.nvidia.com) or [build.nvidia.com](https://build.nvidia.com), deploy a Riva ASR NIM (e.g. via Elastic NIM). The UI will show the new function’s ID after deployment.

## Verify Deployment

```bash
# Check pods
oc get pods -n fax -l app.kubernetes.io/instance=ambient-provider

# Check services
oc get svc -n fax -l app.kubernetes.io/instance=ambient-provider

# View logs
oc logs -f deployment/ambient-provider-ambient-provider-api -n fax
```

## Upgrade

```bash
# Cloud Riva (default): API key + Riva function ID required
helm upgrade ambient-provider ./openshift/ambient-provider \
  --namespace fax \
  --set nvidia.apiKey="$NVIDIA_API_KEY" \
  --set nvidia.rivaFunctionId="$RIVA_FUNCTION_ID" \
  --set images.namespace="$NAMESPACE" \
  --set namespace="$NAMESPACE"

# Self-hosted Riva (in-cluster NIM): no function ID
# helm upgrade ... --set nvidia.selfHostedRiva=true --set nvidia.rivaUri='parakeet-nim.nvidia-nim.svc.cluster.local:50051'
```

## Uninstall

```bash
helm uninstall ambient-provider --namespace fax
```
