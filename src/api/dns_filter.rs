//! DNS-based egress filtering for machines.
//!
//! When `allowed_domains` is set on a machine, this module generates shell
//! commands that configure application-layer DNS filtering inside the VM.
//!
//! Strategy:
//! 1. While DNS still works (before filtering), pre-resolve each allowed domain
//!    and write the results to `/etc/hosts`.
//! 2. Overwrite `/etc/resolv.conf` to point at `127.0.0.1` (nothing listening),
//!    so any domain *not* in `/etc/hosts` fails to resolve.
//!
//! This is not a network-layer firewall — it is defence-in-depth that prevents
//! casual/accidental egress to non-allowed domains.

/// Generate shell commands to set up DNS-based egress filtering in a machine.
///
/// Returns a list of commands, each represented as `Vec<String>` (argv).
/// These should be executed inside the machine **before** any user init commands.
pub fn dns_filter_init_commands(allowed_domains: &[String]) -> Vec<Vec<String>> {
    if allowed_domains.is_empty() {
        return Vec::new();
    }

    let domain_list = allowed_domains
        .iter()
        .map(|d| shell_escape(d))
        .collect::<Vec<_>>()
        .join(" ");

    // Single script that:
    //   a) pre-resolves every allowed domain via `getent hosts`
    //   b) writes results into /etc/hosts
    //   c) points /etc/resolv.conf at 127.0.0.1 (nothing listening on :53)
    //
    // After this, only the pre-resolved domains are reachable by name.
    let script = format!(
        r#"
# smolvm DNS egress filter — only allowed domains will resolve
ALLOWED="{domains}"
for domain in $ALLOWED; do
    ip=$(getent hosts "$domain" 2>/dev/null | awk '{{print $1}}' | head -1)
    if [ -n "$ip" ]; then
        echo "$ip $domain" >> /etc/hosts
    else
        echo "dns-filter: WARNING could not pre-resolve $domain" >&2
    fi
done
# Block all future DNS by pointing at localhost (no server on :53)
echo 'nameserver 127.0.0.1' > /etc/resolv.conf
echo '# smolvm DNS filter active — only pre-resolved domains accessible' >> /etc/resolv.conf
echo "dns-filter: activated for $ALLOWED" >&2

# iptables hardening — block raw-IP exfiltration (requires CAP_NET_ADMIN)
if command -v iptables >/dev/null 2>&1; then
    # Allow established connections (responses to allowed requests)
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null
    # Allow loopback
    iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null
    # Allow DNS to localhost (dead resolver, but don't break resolution errors)
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null
    # Allow resolved IPs from /etc/hosts
    for ip in $(awk '{{print $1}}' /etc/hosts | grep -v '^#' | grep -v '127.0.0.1' | grep -v '::1' | sort -u); do
        iptables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null
    done
    # Drop everything else
    iptables -A OUTPUT -j DROP 2>/dev/null
    echo "dns-filter: iptables rules applied" >&2
else
    echo "dns-filter: WARNING iptables not available, DNS-only filtering" >&2
fi
"#,
        domains = domain_list,
    );

    vec![vec!["sh".to_string(), "-c".to_string(), script]]
}

/// Minimal shell escaping — replace single quotes to prevent injection.
fn shell_escape(s: &str) -> String {
    // Strip any character that isn't alphanumeric, dot, dash, or underscore.
    // Domain names should only contain these characters anyway.
    s.chars()
        .filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_domains_produces_no_commands() {
        assert!(dns_filter_init_commands(&[]).is_empty());
    }

    #[test]
    fn produces_single_command() {
        let cmds = dns_filter_init_commands(&["example.com".to_string()]);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0][0], "sh");
        assert_eq!(cmds[0][1], "-c");
        assert!(cmds[0][2].contains("example.com"));
        assert!(cmds[0][2].contains("/etc/resolv.conf"));
    }

    #[test]
    fn multiple_domains() {
        let cmds = dns_filter_init_commands(&[
            "api.anthropic.com".to_string(),
            "example.org".to_string(),
        ]);
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0][2].contains("api.anthropic.com"));
        assert!(cmds[0][2].contains("example.org"));
    }

    #[test]
    fn shell_escape_strips_dangerous_chars() {
        assert_eq!(shell_escape("foo;rm -rf /"), "foorm-rf");
        assert_eq!(shell_escape("example.com"), "example.com");
    }

    #[test]
    fn includes_iptables_hardening() {
        let cmds = dns_filter_init_commands(&["example.com".to_string()]);
        let script = &cmds[0][2];
        assert!(script.contains("iptables -A OUTPUT"));
        assert!(script.contains("iptables -A OUTPUT -j DROP"));
        assert!(script.contains("ESTABLISHED,RELATED"));
    }
}
