# Python rules

- Type hints on every public function and module boundary.
- `pytest` for tests; fixtures over global state.
- `mypy` and `ruff` are part of the verification command.
- No bare `except`, no mutable default arguments, no `print` in library code.
- Use the `src/` layout when the project is a package; keep import roots explicit.
- Prefer `pathlib` over string paths.
- Run `ruff check .`, `mypy .` and `pytest` before marking a task complete.
- Never commit virtual environments, `.pyc` files or local credentials.
