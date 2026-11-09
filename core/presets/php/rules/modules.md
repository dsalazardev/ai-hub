# Module rules

Applies to the `modules` area declared in `paths.areas` of `manifest.yaml`.

- One module per directory: its classes, its templates, its language files and its tests live
  together; a module never reaches into another module's internals, only through its public API.
- A module declares its own schema changes (migrations or SQL install scripts) and they are
  idempotent: running them twice leaves the same schema.
- Extend the host application through its documented hooks, triggers or service providers; never
  patch core files of the framework or of the host application.
- Permissions are checked in the module's entry points before any read or write.
- New strings go to the module's language files; no user-facing literals in code.
- When a module is copied from another one, rename every identifier, table prefix and constant;
  a leftover name from the source module is a defect.
