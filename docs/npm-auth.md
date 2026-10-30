# npm authentication

The checked-in `.npmrc` maps `@marx-org` to GitHub Packages; it contains no
authentication setting that can override the installer's own credentials.

- **Dependabot** uses its automatic GitHub token and the repository's existing
  package Read grants. No Dependabot secret or registry token entry is needed.
- **GitHub Actions** supplies its built-in `GITHUB_TOKEN` as `NODE_AUTH_TOKEN`.
  The pinned reusable workflow grants package Read permission to tests, and
  `setup-node` writes a temporary authenticated user config.
- **Image builds** use the existing BuildKit `NODE_AUTH_TOKEN` secret. The
  Dockerfile adds the environment-variable auth reference only during `npm ci`
  and removes the config in the same image layer. The token is not a build argument.
- **Local Compose** retains the existing secret wiring from `portfoliost/.env`;
  there is no new credential to configure.
- **Local npm commands** can reuse an exported `NODE_AUTH_TOKEN` or the existing
  GitHub CLI login, without modifying `~/.npmrc`:

  ```sh
  sh scripts/npm-auth.sh ci
  npm run build
  npm test
  ```

  Use the wrapper for any npm command that contacts GitHub Packages. It creates
  a temporary user config, preserves other user options, and removes it even if
  npm fails. Only the environment-variable reference is written, not the token.

Run the authentication regression checks with:

```sh
node --test scripts/npm-auth.check.mjs
```
