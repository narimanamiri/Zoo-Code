import { useCallback, useEffect, useRef, useState } from "react"
import { VSCodeTextField, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useQueryClient } from "@tanstack/react-query"

import {
	type ProviderSettings,
	type OrganizationAllowList,
	type ExtensionMessage,
	aiClusterDefaultModelId,
	AI_CLUSTER_DEFAULT_BASE_URL,
} from "@roo-code/types"

import { RouterName } from "@roo/api"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

type AiClusterProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

/**
 * Settings for a self-hosted AI Cluster.
 *
 * The base URL is the only required field — everything else about the
 * deployment (models, context window, whether it can build documents, whether
 * it has a knowledge base) is discovered from the cluster itself. The two
 * checkboxes turn on the parts of it that are not inference: its skills, which
 * are synced into this extension, and its MCP server, which is registered as a
 * tool provider.
 */
export const AiCluster = ({
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: AiClusterProps) => {
	const { t } = useAppTranslation()
	const queryClient = useQueryClient()
	const { routerModels } = useExtensionState()
	const [refreshStatus, setRefreshStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const errorJustReceived = useRef(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === "singleRouterModelFetchResponse" && !message.success) {
				if ((message.values?.provider as RouterName) === "ai-cluster") {
					errorJustReceived.current = true
					setRefreshStatus("error")
					setRefreshError(message.error)
				}
			} else if (message.type === "routerModels") {
				if (refreshStatus === "loading" && !errorJustReceived.current) {
					setRefreshStatus("success")
					queryClient.invalidateQueries({ queryKey: ["routerModels", "ai-cluster"] })
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [refreshStatus, queryClient])

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	const handleRefreshModels = useCallback(() => {
		errorJustReceived.current = false
		setRefreshStatus("loading")
		setRefreshError(undefined)

		const url = apiConfiguration.aiClusterBaseUrl

		if (!url) {
			setRefreshStatus("error")
			setRefreshError(t("settings:providers.refreshModels.missingConfig"))
			return
		}

		vscode.postMessage({
			type: "requestRouterModels",
			values: { aiClusterBaseUrl: url, aiClusterApiKey: apiConfiguration.aiClusterApiKey },
		})
	}, [apiConfiguration, t])

	const handleSyncSkills = useCallback(() => {
		vscode.postMessage({ type: "syncAiClusterSkills" })
	}, [])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.aiClusterBaseUrl || ""}
				onInput={handleInputChange("aiClusterBaseUrl")}
				placeholder={AI_CLUSTER_DEFAULT_BASE_URL}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.aiClusterBaseUrl")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.aiClusterBaseUrlDescription")}
			</div>

			<VSCodeTextField
				value={apiConfiguration?.aiClusterApiKey || ""}
				type="password"
				onInput={handleInputChange("aiClusterApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.aiClusterApiKey")}</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>

			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={refreshStatus === "loading" || !apiConfiguration.aiClusterBaseUrl}
				className="w-full">
				<div className="flex items-center gap-2">
					{refreshStatus === "loading" ? (
						<span className="codicon codicon-loading codicon-modifier-spin" />
					) : (
						<span className="codicon codicon-refresh" />
					)}
					{t("settings:providers.refreshModels.label")}
				</div>
			</Button>
			{refreshStatus === "loading" && (
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.refreshModels.loading")}
				</div>
			)}
			{refreshStatus === "success" && (
				<div className="text-sm text-vscode-foreground">{t("settings:providers.refreshModels.success")}</div>
			)}
			{refreshStatus === "error" && (
				<div className="text-sm text-vscode-errorForeground">
					{refreshError || t("settings:providers.refreshModels.error")}
				</div>
			)}

			<ModelPicker
				apiConfiguration={apiConfiguration}
				defaultModelId={aiClusterDefaultModelId}
				models={routerModels?.["ai-cluster"] ?? {}}
				modelIdKey="aiClusterModelId"
				serviceName="AI Cluster"
				serviceUrl={apiConfiguration.aiClusterBaseUrl || AI_CLUSTER_DEFAULT_BASE_URL}
				setApiConfigurationField={setApiConfigurationField}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>

			<div className="mt-4">
				<VSCodeCheckbox
					checked={apiConfiguration.aiClusterRegisterMcp ?? true}
					onChange={(e: any) => setApiConfigurationField("aiClusterRegisterMcp", e.target.checked)}>
					<span className="font-medium">{t("settings:providers.aiClusterRegisterMcp")}</span>
				</VSCodeCheckbox>
				<div className="text-sm text-vscode-descriptionForeground ml-6 mt-1">
					{t("settings:providers.aiClusterRegisterMcpDescription")}
				</div>
			</div>

			<div className="mt-3">
				<VSCodeCheckbox
					checked={apiConfiguration.aiClusterSyncSkills ?? true}
					onChange={(e: any) => setApiConfigurationField("aiClusterSyncSkills", e.target.checked)}>
					<span className="font-medium">{t("settings:providers.aiClusterSyncSkills")}</span>
				</VSCodeCheckbox>
				<div className="text-sm text-vscode-descriptionForeground ml-6 mt-1">
					{t("settings:providers.aiClusterSyncSkillsDescription")}
				</div>
				<Button
					variant="outline"
					onClick={handleSyncSkills}
					disabled={!apiConfiguration.aiClusterBaseUrl}
					className="w-full mt-2">
					<div className="flex items-center gap-2">
						<span className="codicon codicon-cloud-download" />
						{t("settings:providers.aiClusterSyncSkillsNow")}
					</div>
				</Button>
			</div>
		</>
	)
}
