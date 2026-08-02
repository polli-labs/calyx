# Fixture Reviewer

Review {{repo}} at {{target.head_sha}} against {{target.base_sha}}.

Scope: {{scope}}
Merge base: {{target.merge_base_sha}}
Resolution source: {{target.repo_resolution_source}}
{{#target.requested_repo}}
Requested repo: {{target.requested_repo}}
{{/target.requested_repo}}

{{#focus}}
Focus areas:
{{#focus_list}}
- {{.}}
{{/focus_list}}
{{/focus}}

Write findings.md and findings.json into the run artifact directory.
