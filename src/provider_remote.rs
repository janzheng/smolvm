//! Remote machine provider — talks to a remote smolvm instance via HTTP.
//!
//! This enables multi-node topologies: a local smolvm instance can manage
//! machines on a remote smolvm server by delegating over the REST API.

use async_trait::async_trait;
use serde::Deserialize;

use crate::api::types::{
    CreateMachineRequest, ExecRequest, ExecResponse, ListMachinesResponse,
    MachineInfo,
};
use crate::provider::{ProviderError, ProviderInfo, MachineProvider};

/// Health response with owned strings (for deserialization from remote).
#[derive(Deserialize)]
struct RemoteHealthResponse {
    status: String,
}

/// Remote provider that communicates with a smolvm server via HTTP.
pub struct RemoteProvider {
    /// Base URL of the remote smolvm instance (e.g., "http://10.0.0.5:8080").
    base_url: String,
    /// Optional bearer token for authentication.
    api_token: Option<String>,
    /// HTTP client.
    client: reqwest::Client,
}

impl RemoteProvider {
    /// Create a new remote provider pointing at the given URL.
    pub fn new(base_url: String, api_token: Option<String>) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_token,
            client: reqwest::Client::new(),
        }
    }

    /// Build a request to the remote server, with an API v1 path.
    fn api_request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}/api/v1{}", self.base_url, path);
        let mut req = self.client.request(method, &url);
        if let Some(ref token) = self.api_token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }
        req
    }

    /// Build a request to the remote server at an absolute path (e.g., /health).
    fn raw_request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.client.request(method, &url);
        if let Some(ref token) = self.api_token {
            req = req.header("Authorization", format!("Bearer {}", token));
        }
        req
    }

    /// Send a response and handle error status codes.
    async fn handle_response(resp: reqwest::Response) -> Result<reqwest::Response, ProviderError> {
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderError::NotFound(text));
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Internal(format!(
                "HTTP {} — {}",
                status, text
            )));
        }
        Ok(resp)
    }
}

#[async_trait]
impl MachineProvider for RemoteProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            name: "remote".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            capabilities: vec![
                "exec", "files", "mcp", "secrets", "merge", "clone",
                "snapshots", "containers", "images",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            max_machines: None,
            region: Some(self.base_url.clone()),
        }
    }

    async fn create(&self, req: CreateMachineRequest) -> Result<MachineInfo, ProviderError> {
        let resp = self
            .api_request(reqwest::Method::POST, "/machines")
            .json(&req)
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        let resp = Self::handle_response(resp).await?;
        resp.json()
            .await
            .map_err(|e| ProviderError::Internal(format!("JSON decode: {}", e)))
    }

    async fn start(&self, id: &str) -> Result<MachineInfo, ProviderError> {
        let resp = self
            .api_request(reqwest::Method::POST, &format!("/machines/{}/start", id))
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        let resp = Self::handle_response(resp).await?;
        resp.json()
            .await
            .map_err(|e| ProviderError::Internal(format!("JSON decode: {}", e)))
    }

    async fn stop(&self, id: &str) -> Result<(), ProviderError> {
        let resp = self
            .api_request(reqwest::Method::POST, &format!("/machines/{}/stop", id))
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        Self::handle_response(resp).await?;
        Ok(())
    }

    async fn delete(&self, id: &str) -> Result<(), ProviderError> {
        let resp = self
            .api_request(
                reqwest::Method::DELETE,
                &format!("/machines/{}?force=true", id),
            )
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        Self::handle_response(resp).await?;
        Ok(())
    }

    async fn get(&self, id: &str) -> Result<MachineInfo, ProviderError> {
        let resp = self
            .api_request(reqwest::Method::GET, &format!("/machines/{}", id))
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        let resp = Self::handle_response(resp).await?;
        resp.json()
            .await
            .map_err(|e| ProviderError::Internal(format!("JSON decode: {}", e)))
    }

    async fn list(&self) -> Result<Vec<MachineInfo>, ProviderError> {
        let resp = self
            .api_request(reqwest::Method::GET, "/machines")
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        let resp = Self::handle_response(resp).await?;
        let body: ListMachinesResponse = resp
            .json()
            .await
            .map_err(|e| ProviderError::Internal(format!("JSON decode: {}", e)))?;
        Ok(body.machines)
    }

    async fn exec(
        &self,
        id: &str,
        req: ExecRequest,
    ) -> Result<ExecResponse, ProviderError> {
        let resp = self
            .api_request(reqwest::Method::POST, &format!("/machines/{}/exec", id))
            .json(&req)
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        let resp = Self::handle_response(resp).await?;
        resp.json()
            .await
            .map_err(|e| ProviderError::Internal(format!("JSON decode: {}", e)))
    }

    async fn health(&self) -> Result<bool, ProviderError> {
        let resp = self
            .raw_request(reqwest::Method::GET, "/health")
            .send()
            .await
            .map_err(|e| ProviderError::Connection(e.to_string()))?;
        let resp = Self::handle_response(resp).await?;
        let body: RemoteHealthResponse = resp
            .json()
            .await
            .map_err(|e| ProviderError::Internal(format!("JSON decode: {}", e)))?;
        Ok(body.status == "ok")
    }
}
