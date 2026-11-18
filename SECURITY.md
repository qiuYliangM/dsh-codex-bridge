# Security and trust boundary

DSH Codex Bridge is a local bridge for two trusted clients running as the same OS user.
It is not a multi-user service, a sandbox, or a cross-host authentication layer.

- The standard plugin exposes MCP only to loopback callers with an exact Host/Origin fence and a private bearer token. Credentials and ownership records are stored under `~/.peerbridge/registrations/`; the owned Codex MCP entry also contains its token. Those files use owner-only POSIX permissions.
- Automatic registration writes only the named user MCP entry through Codex's version-checked configuration RPC. It refuses foreign connections and active competing owners. Forced host shutdown or offline package removal cannot always execute cleanup; the stopped route cannot run calls and the same profile can recover its registration. The explicit cleanup command inspects ownership before removing stale registrations. Shared user history is retained by default.
- DSH gateway URLs must use HTTP(S) on `127.0.0.1`, `localhost`, or `[::1]` and include a token. The gateway address file and the bridge's own `config.json` are written with owner-only permissions on POSIX systems.
- `~/.peerbridge/` contains plaintext credentials, message snippets, short-lived pending questions and local session indexes. Do not commit or share this directory, chat logs, or a gateway URL containing a real token.
- Sending requires explicit project and session identifiers. Queue acceptance does not mean a model completed the task.
- A peer's text is ordinary input. The receiving agent must apply its own permissions and must not treat a source label as authentication or higher-priority instructions.
- Project creation can create directories only when `createDirectory: true` is provided. Codex desktop registration may select the project and may require a trust confirmation in the app. It does not submit a prompt.
- Desktop synchronization reads Codex's persisted state and invokes its existing deep link. It does not patch the app or write its state file. These internal formats may change after client updates. Workspace deletion is not exposed by this bridge.
- Experimental Codex RPCs and DSH gateway methods are version-dependent. Partial outcomes include identifiers or incomplete receipts; query the existing result before retrying a creation.

The repository and release archives do not include Codex, DeepSeek Harness, API keys, account data, or conversation history. The vendored `ws` library retains its upstream MIT license.

For a suspected vulnerability, use GitHub's private vulnerability reporting if enabled. Do not put credentials or private chat content in a public issue.
