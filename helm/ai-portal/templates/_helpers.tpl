{{- define "ai-portal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-portal.fullname" -}}
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

{{- define "ai-portal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ai-portal.labels" -}}
helm.sh/chart: {{ include "ai-portal.chart" . }}
{{ include "ai-portal.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ai-portal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-portal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ai-portal.secretName" -}}
{{- default (include "ai-portal.fullname" .) .Values.existingSecret }}
{{- end }}

{{/* name of the CloudNativePG cluster; its app secret is <name>-app */}}
{{- define "ai-portal.dbName" -}}
{{- printf "%s-db" (include "ai-portal.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
