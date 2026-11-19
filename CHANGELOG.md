# Changelog

All notable changes to SQL Scratchpad are documented in this file.

## [Unreleased]

### Changed

- Renamed the project from SQLyard to **SQL Scratchpad** (`sql-scratchpad`, `sql-scratchpad.com`) to avoid confusion with an unrelated existing SQL brand.
- Renamed workspace package scope (`@sql-scratchpad/*`), Docker image and Compose project names (`sql-scratchpad`, `sql-scratchpad-db`), environment variable prefix (`SQLSCRATCHPAD_*`), MariaDB admin user (`scratchpad_admin`), and browser storage key (`sql-scratchpad:v1`).
- Added a link to sister project [py-scratchpad.com](https://py-scratchpad.com) in the About dialog.

## [0.2.0] - 2026-11-19

### Added

- Initial public open-source release with MariaDB 11.4 isolated workspaces, `sample-library` and `empty` datasets, `.sql` bulk import (up to 6 MB / 60,000 statements), and a Letos-style Vue 3 + CodeMirror 6 frontend.
