{{- define "open-agent-harness.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "open-agent-harness.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "open-agent-harness.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "open-agent-harness.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" -}}
{{- end -}}

{{- define "open-agent-harness.configName" -}}
{{- if .Values.config.nameOverride -}}
{{- .Values.config.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-config" (include "open-agent-harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "open-agent-harness.apiServerName" -}}
{{- printf "%s-api" (include "open-agent-harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "open-agent-harness.workerName" -}}
{{- printf "%s-sandbox" (include "open-agent-harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "open-agent-harness.workerInternalServiceName" -}}
{{- printf "%s-sandbox-internal" (include "open-agent-harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "open-agent-harness.controllerName" -}}
{{- printf "%s-controller" (include "open-agent-harness.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "open-agent-harness.controllerServiceAccountName" -}}
{{- if .Values.controller.serviceAccount.name -}}
{{- .Values.controller.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "open-agent-harness.controllerName" . -}}
{{- end -}}
{{- end -}}

{{- define "open-agent-harness.componentLabels" -}}
helm.sh/chart: {{ include "open-agent-harness.chart" .root }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/name: open-agent-harness
app.kubernetes.io/part-of: open-agent-harness
app.kubernetes.io/component: {{ .component }}
{{- with .root.Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "open-agent-harness.componentSelectorLabels" -}}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/name: open-agent-harness
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "open-agent-harness.probe" -}}
{{- $probe := .probe -}}
{{- if $probe.httpGet }}
httpGet:
  {{- toYaml $probe.httpGet | nindent 2 }}
{{- end }}
{{- with $probe.initialDelaySeconds }}
initialDelaySeconds: {{ . }}
{{- end }}
{{- with $probe.periodSeconds }}
periodSeconds: {{ . }}
{{- end }}
{{- with $probe.timeoutSeconds }}
timeoutSeconds: {{ . }}
{{- end }}
{{- with $probe.successThreshold }}
successThreshold: {{ . }}
{{- end }}
{{- with $probe.failureThreshold }}
failureThreshold: {{ . }}
{{- end }}
{{- end -}}
