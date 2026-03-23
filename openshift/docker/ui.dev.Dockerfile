# Development UI container using approved Ubuntu 24.04 base
FROM ubuntu:24.04

# Install Node.js 20.x from NodeSource repository and curl for health checks
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first
COPY apps/ui/package.json apps/ui/package-lock.json ./

# Copy local NVIDIA package files
COPY apps/ui/kui-foundations-0.403.0.tgz ./
COPY apps/ui/kui-react-0.402.1.tgz ./
COPY apps/ui/nv-brand-assets-icons-3.8.0.tgz ./
COPY apps/ui/nv-brand-assets-react-icons-inline-3.8.0.tgz ./

# Remove package-lock to avoid conflicts with file: dependencies
RUN rm -f package-lock.json

# Install all dependencies (force to ignore version conflicts)
RUN npm install --force

# Copy source code
COPY apps/ui ./

# OpenShift runs containers as an arbitrary non-root UID; make /app writable so
# Vite can write cache to node_modules/.vite and any other runtime writes succeed
RUN chmod -R a+w /app

# Expose Vite dev server port
EXPOSE 5173

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:5173/ || exit 1

# Start development server with fallback approach
CMD ["sh", "-c", "npm run dev -- --host 0.0.0.0 || node /app/node_modules/vite/bin/vite.js --host 0.0.0.0"]