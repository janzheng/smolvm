//! Built-in starter registry.
//!
//! Maps starter names to OCI images + default configuration.
//! Starters provide pre-configured environments (Python, Node, etc.)
//! that can be used with `from_starter` in sandbox creation.

use crate::api::types::StarterInfo;

/// A starter configuration.
pub struct StarterConfig {
    /// OCI image reference.
    pub image: &'static str,
    /// Init commands to run after pulling the image.
    pub init_commands: &'static [&'static str],
    /// Default non-root user.
    pub default_user: Option<&'static str>,
    /// Description of what's included.
    pub description: &'static str,
}

/// Built-in starters registry.
static STARTERS: &[(&str, StarterConfig)] = &[
    (
        "claude-code",
        StarterConfig {
            image: "ghcr.io/smol-machines/smolvm-claude-code:latest",
            init_commands: &[
                "mkdir -p /storage && mount /dev/vda /storage 2>/dev/null || true",
                "apk update && apk add --no-cache nodejs npm python3 git openssh-client curl",
                "npm install -g @anthropic-ai/claude-code",
                "mkdir -p /tmp/claude-1000 && chmod 1777 /tmp && chown agent:agent /tmp/claude-1000",
                "git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace",
                "mkdir -p /storage/workspace && cd /storage/workspace && git init && printf 'node_modules/\\n__pycache__/\\n*.pyc\\n.env\\n' > .gitignore && git add -A && git commit --allow-empty -m 'workspace init'",
                "rm -rf /workspace && ln -sfn /storage/workspace /workspace",
                "chown -R agent:agent /storage/workspace 2>/dev/null; su agent -c 'git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace' 2>/dev/null || true",
            ],
            default_user: Some("agent"),
            description: "Node.js 20 + Python 3 + Claude Code CLI + git workspace",
        },
    ),
    (
        "node-deno",
        StarterConfig {
            image: "ghcr.io/smol-machines/smolvm-node-deno:latest",
            init_commands: &[
                "mkdir -p /storage && mount /dev/vda /storage 2>/dev/null || true",
                "apk update && apk add --no-cache nodejs npm git curl",
                "git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace",
                "mkdir -p /storage/workspace && cd /storage/workspace && git init && printf 'node_modules/\\n__pycache__/\\n*.pyc\\n.env\\n' > .gitignore && git add -A && git commit --allow-empty -m 'workspace init'",
                "rm -rf /workspace && ln -sfn /storage/workspace /workspace",
                "chown -R agent:agent /storage/workspace 2>/dev/null; su agent -c 'git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace' 2>/dev/null || true",
            ],
            default_user: Some("agent"),
            description: "Node.js 20 + npm + git workspace",
        },
    ),
    (
        "python-ml",
        StarterConfig {
            image: "ghcr.io/smol-machines/smolvm-python-ml:latest",
            init_commands: &[
                "mkdir -p /storage && mount /dev/vda /storage 2>/dev/null || true",
                "apk update && apk add --no-cache python3 py3-pip py3-numpy git curl",
                "git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace",
                "mkdir -p /storage/workspace && cd /storage/workspace && git init && printf 'node_modules/\\n__pycache__/\\n*.pyc\\n.env\\n' > .gitignore && git add -A && git commit --allow-empty -m 'workspace init'",
                "rm -rf /workspace && ln -sfn /storage/workspace /workspace",
                "chown -R agent:agent /storage/workspace 2>/dev/null; su agent -c 'git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace' 2>/dev/null || true",
            ],
            default_user: Some("agent"),
            description: "Python 3 + pip + numpy + git workspace",
        },
    ),
    (
        "universal",
        StarterConfig {
            image: "ghcr.io/smol-machines/smolvm-universal:latest",
            init_commands: &[
                "mkdir -p /storage && mount /dev/vda /storage 2>/dev/null || true",
                "apk update && apk add --no-cache nodejs npm python3 py3-pip git curl go rust cargo",
                "npm install -g @anthropic-ai/claude-code",
                "git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace",
                "mkdir -p /storage/workspace && cd /storage/workspace && git init && printf 'node_modules/\\n__pycache__/\\n*.pyc\\n.env\\n' > .gitignore && git add -A && git commit --allow-empty -m 'workspace init'",
                "rm -rf /workspace && ln -sfn /storage/workspace /workspace",
                "chown -R agent:agent /storage/workspace 2>/dev/null; su agent -c 'git config --global user.name smolvm && git config --global user.email smolvm@localhost && git config --global --add safe.directory /storage/workspace && git config --global --add safe.directory /workspace' 2>/dev/null || true",
            ],
            default_user: Some("agent"),
            description: "Node.js + Python + Go + Rust + Claude Code + git workspace — all-in-one",
        },
    ),
];

/// Look up a starter by name.
pub fn get_starter(name: &str) -> Option<&'static StarterConfig> {
    STARTERS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, config)| config)
}

/// List all available starters.
pub fn list_starters() -> Vec<StarterInfo> {
    STARTERS
        .iter()
        .map(|(name, config)| StarterInfo {
            name: name.to_string(),
            image: config.image.to_string(),
            description: config.description.to_string(),
            default_user: config.default_user.map(String::from),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_starter_found() {
        let starter = get_starter("python-ml");
        assert!(starter.is_some());
        let s = starter.unwrap();
        assert!(s.image.contains("python-ml"));
        assert_eq!(s.default_user, Some("agent"));
    }

    #[test]
    fn test_get_starter_not_found() {
        assert!(get_starter("nonexistent").is_none());
    }

    #[test]
    fn test_list_starters() {
        let starters = list_starters();
        assert!(starters.len() >= 4);
        let names: Vec<&str> = starters.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"claude-code"));
        assert!(names.contains(&"python-ml"));
        assert!(names.contains(&"node-deno"));
        assert!(names.contains(&"universal"));
    }
}
