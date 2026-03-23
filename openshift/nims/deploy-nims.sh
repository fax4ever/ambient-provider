#!/bin/bash
# Deploy NVIDIA NIMs with NIM Operator

set -euo pipefail

NIM_NAMESPACE=${NIM_NAMESPACE:-nvidia-nim}
SCRIPT_DIR="$(dirname "$0")"

echo "Deploying NVIDIA NIMs"
echo "Namespace: $NIM_NAMESPACE"

# Check if logged in
if ! oc whoami &> /dev/null; then
    echo "ERROR: Not logged in to OpenShift. Run 'oc login' first."
    exit 1
fi

# Check for NGC API key
if [ -z "${NGC_API_KEY:-}" ]; then
    echo "ERROR: NGC_API_KEY environment variable not set."
    echo "Export your NGC API key: export NGC_API_KEY='your-key-here'"
    exit 1
fi

# Create namespace
echo "Creating namespace $NIM_NAMESPACE..."
oc create namespace $NIM_NAMESPACE 2>/dev/null || echo "Namespace already exists"

# Create NGC secret for environment variables
echo "Creating NGC API secret..."
oc create secret generic ngc-api-secret \
    --from-literal=NGC_API_KEY="$NGC_API_KEY" \
    -n $NIM_NAMESPACE \
    --dry-run=client -o yaml | oc apply -f -

# Create image pull secret
echo "Creating image pull secret..."
oc create secret docker-registry ngc-secret \
    --docker-server=nvcr.io \
    --docker-username='$oauthtoken' \
    --docker-password="$NGC_API_KEY" \
    -n $NIM_NAMESPACE \
    --dry-run=client -o yaml | oc apply -f -

# Link image pull secret to default service account
echo "Linking image pull secret to service accounts..."
oc secrets link default ngc-secret --for=pull -n $NIM_NAMESPACE 2>/dev/null || true

# Create PVCs for model storage
echo "Creating PVCs for model storage..."
sed "s/namespace: nvidia-nim/namespace: $NIM_NAMESPACE/g" "$SCRIPT_DIR/pvcs.yaml" | oc apply -f - || { echo "ERROR: Failed to create PVCs"; exit 1; }

# Deploy Parakeet NIM (replace namespace in YAML)
echo "Deploying Parakeet NIM (ASR)..."
sed "s/namespace: nvidia-nim/namespace: $NIM_NAMESPACE/g" "$SCRIPT_DIR/parakeet-nim.yaml" | oc apply -f - || { echo "ERROR: Failed to deploy Parakeet NIM"; exit 1; }

# Deploy Llama NIM (replace namespace in YAML)
echo "Deploying Llama NIM (LLM)..."
sed "s/namespace: nvidia-nim/namespace: $NIM_NAMESPACE/g" "$SCRIPT_DIR/llama-nim.yaml" | oc apply -f - || { echo "ERROR: Failed to deploy Llama NIM"; exit 1; }

# Wait a moment for service accounts to be created, then link secrets
echo "Waiting for service accounts to be created..."
sleep 5

echo "Linking image pull secrets to NIM service accounts..."
oc secrets link parakeet-nim ngc-secret --for=pull -n $NIM_NAMESPACE 2>/dev/null || echo "Note: parakeet-nim serviceaccount not yet created"
oc secrets link llama-nim ngc-secret --for=pull -n $NIM_NAMESPACE 2>/dev/null || echo "Note: llama-nim serviceaccount not yet created"

echo ""
echo "✓ NIM deployments created successfully!"
echo ""
echo "Monitor deployment status:"
echo "  oc get nimservice -n $NIM_NAMESPACE"
echo "  oc get pods -n $NIM_NAMESPACE -w"
echo ""
echo "Note: First start may take 10-30 minutes as models are downloaded."
