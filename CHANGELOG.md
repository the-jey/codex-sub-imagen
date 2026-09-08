# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-09-08

### Added

- GPT Image 2.5 Sunburst as the default image model.
- GPT Image 2.5 Flare as a faster alternative.
- Quality levels through `max`, validated custom dimensions, background mode,
  and output compression controls.
- Up to four local or attached reference images for generation and editing.
- PNG, JPEG, and WebP output with configurable save modes.
- Internal retries with backoff and `Retry-After` support.

### Changed

- Separated the Codex `routerModel` from the image backend `imageModel`.
- Parse the complete SSE response before reporting backend image failures.
- Send the GPT Image 2.5 model and generation options explicitly.
- Adopted `codex-sub-imagen.json` as the canonical configuration filename.

### Compatibility

- Preserve support for legacy `model` and `imagePath` tool arguments.
- Preserve support for the former `codex-image-gen.json` configuration file.

[Unreleased]: https://github.com/the-jey/codex-sub-imagen/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/the-jey/codex-sub-imagen/releases/tag/v0.3.0
