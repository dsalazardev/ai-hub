# PHP rules

Stack: {{stack.languages}} · dependencies with {{stack.packageManager}}.

- `declare(strict_types=1);` at the top of every new file; typed parameters, returns and properties.
- Dependencies only through Composer: never copy a library into the repository, never edit `vendor/`.
- Autoload with PSR-4 from `composer.json`; no manual `require` of project classes.
- Tests with PHPUnit under `tests/`; a test per behaviour, no shared global state between tests.
- On a Laravel project, `php artisan test` replaces `vendor/bin/phpunit` in the `test` and `verify`
  commands of `manifest.yaml`; migrations go through `php artisan migrate`, never hand-written SQL
  against a shared database.
- Database access through prepared statements or the framework's query builder; never concatenate
  request input into SQL.
- Escape output in templates; validate and cast every request input at the boundary.
- No `@` error suppression, no `eval`, no `extract` on request data.
- Run `composer validate --strict`, the static analyser and the test suite before marking a task
  complete.
- Never commit `vendor/`, `.env` files or local credentials.
