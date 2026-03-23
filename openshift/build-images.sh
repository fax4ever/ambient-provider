#!/bin/bash
# Build Ambient Provider images on OpenShift
# Usage: ./build-images.sh [api|ui|nginx]
#   No argument: build all images
#   One argument: build only the specified image

set -euo pipefail

NAMESPACE=${NAMESPACE:-ambient-provider}
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD_TARGET="${1:-all}"

# Cleanup function
cleanup() {
    [ -f "$REPO_ROOT/ambient-scribe/Dockerfile" ] && rm -f "$REPO_ROOT/ambient-scribe/Dockerfile"
    [ -f "$REPO_ROOT/ambient-scribe/infra/Dockerfile" ] && rm -f "$REPO_ROOT/ambient-scribe/infra/Dockerfile"
}
trap cleanup EXIT

echo "Building Ambient Provider images on OpenShift"
echo "Namespace: $NAMESPACE"
echo "Target: $BUILD_TARGET"
echo ""

# Check if logged in
if ! oc whoami &> /dev/null; then
    echo "ERROR: Not logged in to OpenShift. Run 'oc login' first."
    exit 1
fi

# Create namespace if needed
oc project $NAMESPACE 2>/dev/null || oc new-project $NAMESPACE

build_api() {
    echo "Building API..."
    if ! oc get bc ambient-api &>/dev/null; then
        oc new-build --name=ambient-api --binary --strategy=docker || { echo "ERROR: Failed to create BuildConfig for API"; exit 1; }
    fi
    local asr="$REPO_ROOT/ambient-scribe/apps/api/ambient_scribe/services/asr.py"
    cd "$REPO_ROOT/ambient-scribe"
    cp "$asr" "${asr}.bak"
    cp "$REPO_ROOT/openshift/patches/ambient_scribe/services/asr.py" "$asr"
    cp "$REPO_ROOT/openshift/docker/api.Dockerfile" ./Dockerfile || { mv "${asr}.bak" "$asr"; echo "ERROR: Failed to copy API Dockerfile"; exit 1; }
    oc start-build ambient-api --from-dir=. --follow || { rm -f ./Dockerfile; mv "${asr}.bak" "$asr"; echo "ERROR: API build failed"; exit 1; }
    rm ./Dockerfile
    mv "${asr}.bak" "$asr"
}

build_ui() {
    echo "Building UI..."
    if ! oc get bc ambient-ui &>/dev/null; then
        oc new-build --name=ambient-ui --binary --strategy=docker || { echo "ERROR: Failed to create BuildConfig for UI"; exit 1; }
    fi
    local vite="$REPO_ROOT/ambient-scribe/apps/ui/vite.config.ts"
    cd "$REPO_ROOT/ambient-scribe"
    cp "$vite" "${vite}.bak"
    python3 -c "
from pathlib import Path
p = Path(r'''$vite''')
t = p.read_text()
if '.openshift.com' not in t:
    t = t.replace(
        \"allowedHosts: ['.ngrok-free.app', '.brevlab.com']\",
        \"allowedHosts: ['.ngrok-free.app', '.brevlab.com', '.openshift.com']\",
    )
    p.write_text(t)
"
    cp "$REPO_ROOT/openshift/docker/ui.dev.Dockerfile" ./Dockerfile || { mv "${vite}.bak" "$vite"; echo "ERROR: Failed to copy UI Dockerfile"; exit 1; }
    oc start-build ambient-ui --from-dir=. --follow || { rm -f ./Dockerfile; mv "${vite}.bak" "$vite"; echo "ERROR: UI build failed"; exit 1; }
    rm ./Dockerfile
    mv "${vite}.bak" "$vite"
}

build_nginx() {
    echo "Building Nginx..."
    if ! oc get bc ambient-nginx &>/dev/null; then
        oc new-build --name=ambient-nginx --binary --strategy=docker || { echo "ERROR: Failed to create BuildConfig for Nginx"; exit 1; }
    fi
    cd "$REPO_ROOT/ambient-scribe/infra"
    cp docker/nginx.ubuntu.Dockerfile ./Dockerfile || { echo "ERROR: Failed to copy Nginx Dockerfile"; exit 1; }
    oc start-build ambient-nginx --from-dir=. --follow || { echo "ERROR: Nginx build failed"; exit 1; }
    rm ./Dockerfile
}

case "$BUILD_TARGET" in
    api)   build_api ;;
    ui)    build_ui ;;
    nginx) build_nginx ;;
    all)
        build_api
        build_ui
        build_nginx
        ;;
    *)
        echo "ERROR: Unknown target '$BUILD_TARGET'. Use: api, ui, nginx, or all (default)."
        exit 1
        ;;
esac

echo ""
echo "✓ Build(s) completed successfully!"
echo ""
echo "View images: oc get imagestreams"
