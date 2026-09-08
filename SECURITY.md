# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose
credentials, private images, or local files. Use GitHub's private vulnerability
reporting feature for this repository instead.

Include the affected version, reproduction steps, expected impact, and any
suggested mitigation. Please allow a reasonable amount of time for a fix before
public disclosure.

## Sensitive local data

This extension uses credentials supplied by Pi's model registry. Never commit
Pi authentication files, access tokens, generated private assets, or local
configuration containing secrets. The extension does not require credentials
to be stored in this repository.
