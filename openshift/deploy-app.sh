#!/bin/bash
# Deploy Ambient Provider application with Helm

set -euo pipefail

NAMESPACE=${NAMESPACE:-fax}
RELEASE_NAME=${RELEASE_NAME:-ambient-provider}

echo "Deploying Ambient Provider"
echo "Namespace: $NAMESPACE"
echo "Release: $RELEASE_NAME"

# Check if logged in
if ! oc whoami &> /dev/null; then
    echo "ERROR: Not logged in to OpenShift. Run 'oc login' first."
    exit 1
fi

# Check for NVIDIA API key
if [ -z "${NVIDIA_API_KEY:-}" ]; then
    echo "ERROR: NVIDIA_API_KEY environment variable not set."
    echo "Export your NVIDIA API key: export NVIDIA_API_KEY='nvapi-your-key-here'"
    echo "Get it from: https://build.nvidia.com/"
    exit 1
fi

# Check if images exist
echo "Checking if images exist..."
oc get imagestream ambient-api -n $NAMESPACE &>/dev/null || { echo "ERROR: ambient-api image not found. Run ./openshift/build-images.sh first"; exit 1; }
oc get imagestream ambient-ui -n $NAMESPACE &>/dev/null || { echo "ERROR: ambient-ui image not found. Run ./openshift/build-images.sh first"; exit 1; }
oc get imagestream ambient-nginx -n $NAMESPACE &>/dev/null || { echo "ERROR: ambient-nginx image not found. Run ./openshift/build-images.sh first"; exit 1; }

# Install Helm chart
echo "Installing Helm chart..."
helm install $RELEASE_NAME "$(dirname "$0")/ambient-provider" \
    --namespace $NAMESPACE \
    --set nvidia.apiKey="$NVIDIA_API_KEY" \
    --set nvidia.rivaFunctionId="${RIVA_FUNCTION_ID:-}" \
    --set images.namespace="$NAMESPACE" \
    --set namespace="$NAMESPACE" \
    || { echo "ERROR: Helm install failed"; exit 1; }

echo ""
echo "✓ Ambient Provider deployed successfully!"
echo ""
echo "Get the application URL:"
echo "  oc get route $RELEASE_NAME-ambient-provider -n $NAMESPACE -o jsonpath='{.spec.host}'"
echo ""
echo "Monitor deployment:"
echo "  oc get pods -n $NAMESPACE -w"
