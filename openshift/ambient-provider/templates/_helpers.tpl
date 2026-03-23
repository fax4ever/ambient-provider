{{/*
Expand the name of the chart.
*/}}
{{- define "ambient-provider.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ambient-provider.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "ambient-provider.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "ambient-provider.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
API image
*/}}
{{- define "ambient-provider.apiImage" -}}
{{- printf "%s/%s/%s:%s" .Values.images.registry .Values.images.namespace .Values.images.api.repository .Values.images.api.tag }}
{{- end }}

{{/*
UI image
*/}}
{{- define "ambient-provider.uiImage" -}}
{{- printf "%s/%s/%s:%s" .Values.images.registry .Values.images.namespace .Values.images.ui.repository .Values.images.ui.tag }}
{{- end }}

{{/*
Nginx image
*/}}
{{- define "ambient-provider.nginxImage" -}}
{{- printf "%s/%s/%s:%s" .Values.images.registry .Values.images.namespace .Values.images.nginx.repository .Values.images.nginx.tag }}
{{- end }}
