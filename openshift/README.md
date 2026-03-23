# OpenShift deployment

OpenShift-specific Dockerfiles, API patches, and Helm live under this directory. The main app tree under `ambient-scribe/` stays unchanged; `build-images.sh` overlays patches during image builds.

## Build images on OpenShift

### Option 1: Build script (recommended)

```bash
./openshift/build-images.sh
```

This uses `openshift/docker/api.Dockerfile`, `openshift/docker/ui.dev.Dockerfile`, and temporary overlays:

- **API:** `openshift/patches/ambient_scribe/services/asr.py` (cloud Riva `RIVA_FUNCTION_ID` validation and trimming).
- **UI:** adds `.openshift.com` to Vite `server.allowedHosts` and uses the OpenShift UI Dockerfile (writable `/app` for arbitrary UIDs).

### Option 2: Manual `oc` commands

From the repository root:

```bash
oc new-project ambient-provider

# API
oc new-build --name=ambient-api --binary --strategy=docker
cd ambient-scribe
cp ../openshift/docker/api.Dockerfile ./Dockerfile
# Optional: apply API patch before build (same as the script)
cp ../openshift/patches/ambient_scribe/services/asr.py apps/api/ambient_scribe/services/asr.py
oc start-build ambient-api --from-dir=. --follow
rm ./Dockerfile

# UI
oc new-build --name=ambient-ui --binary --strategy=docker
cp ../openshift/docker/ui.dev.Dockerfile ./Dockerfile
# Optional: add OpenShift route host to vite.config.ts allowedHosts (see build-images.sh)
oc start-build ambient-ui --from-dir=. --follow
rm ./Dockerfile
cd ..

# Nginx
cd ambient-scribe/infra
oc new-build --name=ambient-nginx --binary --strategy=docker
cp docker/nginx.ubuntu.Dockerfile ./Dockerfile
oc start-build ambient-nginx --from-dir=. --follow
rm ./Dockerfile
cd ../..
```

## Deploy NIMs with NVIDIA NIM Operator (optional — local NIMs)

If you want to run NIMs on-cluster instead of cloud NIMs:

```bash
export NGC_API_KEY='your-ngc-api-key'
./openshift/nims/deploy-nims.sh

# Or a custom namespace
NIM_NAMESPACE=my-namespace ./openshift/nims/deploy-nims.sh

oc get nimservice -n nvidia-nim
oc get pods -n nvidia-nim -w
```

Requires NVIDIA GPU Operator and NIM Operator, plus sufficient GPU capacity. See [nims/README.md](nims/README.md).

## Deploy the application with Helm (cloud NIMs)

Requires an NVIDIA API key from [build.nvidia.com](https://build.nvidia.com).

```bash
export NVIDIA_API_KEY='nvapi-your-key-here'
./openshift/deploy-app.sh
```

Or with Helm directly:

```bash
helm install ambient-provider ./openshift/ambient-provider \
  --namespace fax \
  --set nvidia.apiKey="$NVIDIA_API_KEY"
```

```bash
oc get route ambient-provider-ambient-provider -n fax -o jsonpath='{.spec.host}'
```

See [ambient-provider/README.md](ambient-provider/README.md) for values (including UI `VITE_USE_STREAMING`).

## Local env reference (UI)

Example-only file for OpenShift-oriented defaults: [ui.env.example](ui.env.example).
