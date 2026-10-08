# Security Policy

## Supported Versions

Security fixes are applied to the latest released minor version.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier | No |

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature:

`Security` → `Advisories` → `Report a vulnerability`

Include:

- Affected version or commit
- Reproduction steps
- Impact and attack requirements
- A minimal proof of concept when appropriate
- Any suggested mitigation

You should receive an acknowledgment within 5 business days. Confirmed issues will be handled privately until a fix and disclosure plan are ready.

## Security Model

- Source files are processed locally in the Figma plugin.
- The plugin manifest permits no external network domains.
- Dependencies are monitored through Dependabot and CI.
- Untrusted source files are parsed in the plugin UI iframe, not the Figma document sandbox.

Source files can contain malformed or adversarial binary and XML data. Avoid opening unknown files, and keep the plugin updated.
