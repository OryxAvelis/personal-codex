# Personal Codex

A private, local website powered by the installed Codex app server.

## Features

- Add project folders directly from the computer.
- Keep a separate conversation for each project.
- Switch between available Codex models and reasoning levels.
- View the current Codex usage window.
- Approve commands and expanded file access before they run.

## Requirements

- Node.js 20 or newer
- Codex installed and available as `codex`
- A ChatGPT account with Codex access

## Run

Install dependencies once:

```powershell
npm install
```

Then double-click `start.cmd`, or run:

```powershell
npm start
```

Open <http://127.0.0.1:4317>.

The server binds only to `127.0.0.1`. Project metadata and conversation display history are stored in browser local storage, while project files stay in their original folders.
