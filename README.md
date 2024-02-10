# Gemini AI Code Review Tool

This action takes as input `GIT_TOKEN` and `GEMINI_API_KEY` and watches pull/push requests and sends the git diff to AI and comments (in case of PR only) on the PR as well as sending details in email if configured.

Usage:

1 - You need to set up your project's permissions so that the Github Actions can write comments on Pull Requests. You can read more about this here: [automatic-token-authentication](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#modifying-the-permissions-for-the-github_token)

2 - Set `GIT_TOKEN` and `GEMINI_API_KEY`  [as action secrets in your repository](https://docs.github.com/en/actions/security-guides/encrypted-secrets#creating-encrypted-secrets-for-a-repository)

3 - Finally, create a file named `review-action.yml`  inside `.github/workflows` with the following contents:

```
name: Gemini AI Code Review Action

on:
  push:
  pull_request:
    types: [opened, reopened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Gemini AI Code Review Action
        uses: sarfraznawaz2005/ai-code-review-action@main
        with:
          github-token: ${{ secrets.GIT_TOKEN }}
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          email-host: 'xxxxxxxxxxxxxxxxx'
          email-port: 'xxxxxxxxxxxxxxxxx'
          email-user: 'xxxxxxxxxxxxxxxxx'
          email-pass: 'xxxxxxxxxxxxxxxxx
          email-from: 'xxxxxxxxxxxxxxxxx'
          email-to: 'xxxxxxxxxxxxxxxxx'
          email-bcc: 'xxxxxxxxxxxxxxxxx'
          email-secure: 'true' or 'false'
```
