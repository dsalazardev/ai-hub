# Architecture — Angular + Express

- Domain types live in `domain/` and are shared by frontend and BFF.
- The BFF is the only access point to external services.
- Components are standalone, use Signals and `inject()`.
- DALs compose clients; they never inherit from a concrete transport class.
- Tests mock DALs, not individual methods.
- Build, typecheck and tests must pass before a task is complete.
