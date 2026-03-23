# Deploy NIMs with NVIDIA NIM Operator

This directory contains manifests for deploying NVIDIA NIMs locally on OpenShift using the NVIDIA NIM Operator.

## Prerequisites

1. **NVIDIA GPU Operator installed**
   ```bash
   oc get pods -n nvidia-gpu-operator
   ```

2. **NVIDIA NIM Operator installed**
   ```bash
   # Check operator pods (typically in openshift-operators for cluster-wide install)
   oc get pods -n openshift-operators | grep nim

   # Verify NIMService CRD exists
   oc get crd nimservices.apps.nvidia.com
   ```

3. **NGC API Key** from https://org.ngc.nvidia.com/setup/personal-keys

4. **GPU Resources Available:**
   - Parakeet NIM: 1 GPU with 16GB+ VRAM
   - Llama NIM: 4 GPUs with 40GB+ VRAM each (adjust based on your cluster)

> **Note:** When installed via OperatorHub, the NIM Operator typically runs in `openshift-operators` namespace (cluster-wide) but manages NIMService resources in any namespace. This is the standard OpenShift operator pattern.

## Deployment Steps

### 1. Create Namespace

```bash
oc new-project nvidia-nim
```

### 2. Deploy NIMs with Script (Recommended)

```bash
# Export your NGC API key
export NGC_API_KEY='your-ngc-api-key-here'

# Deploy to default namespace (nvidia-nim)
./openshift/nims/deploy-nims.sh

# Or deploy to custom namespace
NIM_NAMESPACE=my-nims ./openshift/nims/deploy-nims.sh
```

The script will:
- Create the namespace
- Create NGC secrets
- Deploy Parakeet and Llama NIMs
- Configure services

### 3. Manual Deployment (Alternative)

If you prefer manual deployment:

```bash
# Create namespace
oc new-project nvidia-nim

# Create secrets
export NGC_API_KEY='your-ngc-api-key-here'

oc create secret generic ngc-api-secret \
  --from-literal=NGC_API_KEY="$NGC_API_KEY" \
  -n nvidia-nim

oc create secret docker-registry ngc-secret \
  --docker-server=nvcr.io \
  --docker-username='$oauthtoken' \
  --docker-password="$NGC_API_KEY" \
  -n nvidia-nim

# Deploy NIMs
oc apply -f openshift/nims/parakeet-nim.yaml
oc apply -f openshift/nims/llama-nim.yaml
```

**Note:** Adjust GPU count in `llama-nim.yaml` based on your available resources before deploying.

## Verify Deployment

### Check NIM Resources

```bash
# List all NIMService resources
oc get nimservice -n nvidia-nim

# Check Parakeet status
oc describe nimservice parakeet-nim -n nvidia-nim

# Check Llama status
oc describe nimservice llama-nim -n nvidia-nim
```

### Check Pods

```bash
# Watch pods starting
oc get pods -n nvidia-nim -w

# Check pod logs
oc logs -f parakeet-nim-<pod-suffix> -n nvidia-nim
oc logs -f llama-nim-<pod-suffix> -n nvidia-nim
```

### Check Services

```bash
oc get svc -n nvidia-nim
```

Expected services:
- `parakeet-nim` - ports 50051 (gRPC), 9000 (HTTP)
- `llama-nim` - port 8000 (HTTP)

## Test NIMs

### Test Parakeet (ASR)

```bash
# Port-forward to test locally
oc port-forward -n nvidia-nim svc/parakeet-nim 9000:9000

# Test health endpoint
curl http://localhost:9000/v1/health
```

### Test Llama (LLM)

```bash
# Port-forward to test locally
oc port-forward -n nvidia-nim svc/llama-nim 8000:8000

# Test health endpoint
curl http://localhost:8000/v1/health

# Test inference
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta/llama-3.1-70b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

## Configure Ambient Provider to Use Local NIMs

Once NIMs are running, update your Ambient Provider deployment to use them:

```yaml
# In your Helm values or ConfigMap
RIVA_URI: "parakeet-nim.nvidia-nim.svc.cluster.local:50051"
OPENAI_BASE_URL: "http://llama-nim.nvidia-nim.svc.cluster.local:8000/v1"
SELF_HOSTED: "true"
```

## Troubleshooting

### Pods stuck in Pending

Check GPU availability:
```bash
oc describe nodes | grep -A 5 "Allocated resources"
```

### Image pull errors

Verify NGC secret:
```bash
oc get secret ngc-secret -n nvidia-nim -o yaml
```

### NIM fails to start

Check NIM Operator logs:
```bash
# Find the operator pods (cluster-wide install typically in openshift-operators)
oc get pods -n openshift-operators | grep nim

# Check logs
oc logs -n openshift-operators <nim-operator-pod-name>
```

### Model download issues

NIMs need to download large models on first start. Check pod logs:
```bash
oc logs -f <nim-pod-name> -n nvidia-nim
```

## Resource Adjustments

### Reduce Llama GPU Count

If you have limited GPUs, you can try with fewer GPUs (may impact performance):

```yaml
# In llama-nim.yaml
resources:
  limits:
    nvidia.com/gpu: 2  # Minimum recommended
```

### Use Smaller Models

Consider using smaller models if resources are limited:
- Parakeet: Already using the smallest model (1.1B)
- Llama: Could use `llama-3.1-8b-instruct` instead (requires only 1-2 GPUs)

## Cleanup

```bash
oc new-project nvidia-nim
```

## Notes

- **First start is slow**: NIMs download models on first start (can take 10-30 minutes)
- **GPU requirements**: Ensure your cluster has sufficient GPU resources
- **Storage**: NIMs need significant storage for model caching (50-200GB per NIM)
- **Network**: Requires internet access to pull images and download models

## Next Steps

After NIMs are deployed and verified:
1. Create Helm chart for Ambient Provider application
2. Configure application to use local NIM endpoints
3. Deploy and test the full stack
