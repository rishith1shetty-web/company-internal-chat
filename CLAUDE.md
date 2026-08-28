# CLAUDE.md — Company Internal Chat & File Transfer System

## 1. Project Overview

Build a private, browser-based company communication platform that allows employees to communicate with each other and transfer files through a centrally hosted application on the company's own server/network.
The application is intended to provide core communication functionality similar to Microsoft Teams, but the first version should focus only on:

* One-to-one chat
* Group chat
* Real-time messaging
* File upload and transfer
* File download
* Basic online/offline presence
* Company-network/IP-restricted access
  The AI chatbot is NOT part of the initial implementation. AI functionality will be introduced only in a later phase after the core communication platform is stable.

## 2. Core Business Requirements

### 2.1 Deployment

The production application must run on a central company server.
The application must NOT require cloud hosting for the initial project.
The production database must run on the company server using PostgreSQL.
Uploaded files must be stored on company-controlled storage.
Employees should access the application through a web browser.
Employees should not need to install an application or executable on their individual computers.
The application should be accessible through the company's network/IP according to the company's network configuration.
Access from unauthorized external networks must be blocked when the production network configuration requires company-only access.

### 2.2 Authentication

The initial version does NOT require username/password authentication.
Do not introduce a complete authentication system unless explicitly requested.
Users may provide a display name when entering the application so that other users can identify them.
The identity/session mechanism must be designed so that it can be replaced or extended with proper company authentication in the future.
Do not assume that display-name identification provides strong security.

### 2.3 Communication

The application must support:

* One-to-one conversations
* Group conversations
* Real-time message delivery
* Message timestamps
* Message history
* Online/offline presence
* Unread message indication where practical
* Basic message validation
  Messages must be persisted in PostgreSQL.
  The UI should update without requiring users to manually refresh the page.

### 2.4 File Transfer

Users must be able to send files inside conversations.
The initial system should support common business file formats such as:

* PDF
* DOC/DOCX
* XLS/XLSX
* PPT/PPTX
* JPG/JPEG
* PNG
* TXT
* ZIP
  File uploads must have configurable size limits.
  File types must be validated.
  Uploaded files must not be exposed through an unrestricted public directory.
  File downloads must go through controlled server-side routes.
  File metadata should be stored in PostgreSQL.
  At minimum, file metadata should include:
* Original filename
* Stored filename/path or storage identifier
* File size
* MIME type
* Sender
* Conversation
* Upload timestamp
  Do not allow directory traversal or unsafe file paths.
  Use generated/unique storage names rather than trusting the original filename as the physical storage filename.

## 3. Technology Direction

Use a modern, maintainable TypeScript-based web stack.
Preferred initial stack:

* Frontend: Next.js + TypeScript
* UI: Tailwind CSS
* UI components: shadcn/ui where appropriate
* Database: PostgreSQL
* ORM/database layer: Prisma unless a strong technical reason requires another solution
* Real-time communication: Socket.IO/WebSockets
* File upload handling: secure server-side upload implementation
* Version control: Git
* Repository: GitHub
* Development environment: VS Code + Claude Code
  Use stable, well-supported packages.
  Do not add a library simply because it is popular.
  Before introducing a new dependency, determine whether it is actually necessary.
  Avoid unnecessary microservices.
  The first version should be a maintainable modular monolith unless there is a clear requirement for a separate service.

## 4. Development Philosophy

Build the system incrementally.
Do not attempt to implement the entire project in one step.
Follow the project phases defined below.
Do not start a later phase until the current phase is reasonably stable and tested.
Do not implement AI functionality during Phases 0–10.
Do not implement cloud infrastructure unless explicitly requested.
Do not add unnecessary enterprise features that are outside the current requirements.
Prefer simple, understandable solutions over unnecessary complexity.
Keep the code production-oriented even during prototyping.
Every major feature should have clear error handling.
Do not silently ignore errors.

## 5. Project Phases

### Phase 0 — Requirements + Architecture

Before development:

1. Confirm the functional requirements.
2. Define system architecture.
3. Define application boundaries.
4. Define database entities and relationships.
5. Define chat/message flow.
6. Define file-transfer flow.
7. Define network/deployment architecture.
8. Define security requirements.
9. Define local development architecture.
10. Define production company-server architecture.
11. Document assumptions and unresolved questions.
    Do not write substantial application code until the architecture is understood.

### Phase 1 — Development Environment

Set up:

* Node.js
* npm/pnpm as selected for the project
* Next.js
* TypeScript
* Git
* PostgreSQL
* Prisma
* Tailwind CSS
* shadcn/ui if required
* Socket.IO/WebSocket infrastructure when needed
  Verify that the application runs locally.
  Create environment-variable configuration.
  Never hard-code passwords, connection strings, API keys, secrets, IP addresses, or other environment-specific values.

### Phase 2 — Chat UI

Build the initial user interface.
Required areas:

* Application header
* User/display-name area
* Conversation list
* Search where appropriate
* Chat window
* Message list
* Message composer
* File attachment control
* Group/conversation controls
  The UI should be responsive and usable on normal company desktops and laptops.
  Keep the interface simple and professional.
  Do not copy Microsoft Teams branding, logos, or proprietary design elements.
  The application may use Teams-like interaction patterns because chat applications commonly use similar layouts.

### Phase 3 — PostgreSQL Database

Design and implement the database.
Initial entities should include concepts such as:

* User/session identity
* Conversation
* Conversation member
* Message
* Group
* File
  Use appropriate primary keys, foreign keys, indexes, timestamps, and constraints.
  Avoid storing unnecessary duplicated data.
  Use migrations.
  Database changes must be reproducible.
  Document the database schema.

### Phase 4 — Real-Time Messaging

Implement real-time message delivery.
Requirements:

* Send message
* Receive message without page refresh
* Persist message
* Load message history
* Handle connection/disconnection
* Handle reconnects appropriately
* Basic online/offline presence
  The real-time layer must not become the source of truth for message history.
  PostgreSQL remains the persistent source of truth.
  Handle duplicate events and reconnect scenarios safely.

### Phase 5 — One-to-One Chat

Implement private conversations between two users.
Requirements:

* Select employee/user
* Open conversation
* Send message
* Receive message in real time
* Load previous messages
* Display timestamps
* Display sender
* Display online/offline status
* Unread indication where appropriate
  Do not allow a user to access arbitrary conversation data without server-side validation.

### Phase 6 — Group Chat

Implement group conversations.
Requirements:

* Create group
* Group name
* Add members
* Remove members where appropriate
* Send messages
* Receive messages in real time
* Group message history
* Group file sharing
* Basic group management
  Server-side authorization must validate group membership before allowing access to group data.

### Phase 7 — File Transfer

Implement secure file transfer.
Requirements:

* Select file
* Validate file
* Upload file
* Store file on company-controlled storage
* Save metadata
* Display file in chat
* Download file
* Show upload progress where practical
* Handle failed uploads
* Handle large files according to configured limits
  Security requirements:
* Validate file size
* Validate MIME type
* Validate extension
* Generate safe storage names
* Prevent path traversal
* Prevent unrestricted public file access
* Validate that the requesting user is allowed to access the file
* Do not execute uploaded files
* Do not trust client-provided metadata
  Keep storage configuration separate from application code.

### Phase 8 — Company IP / Network Restriction

The production system must be configured to operate according to the company's network-access requirement.
The application should ultimately follow this model:
Internet/Company Network
→ Company Router/Firewall
→ Company Server
→ Chat Application
→ PostgreSQL + File Storage
Do not assume a specific IP address, subnet, firewall, port, or router configuration.
Use placeholders/environment configuration until the actual company network details are provided.
Network restriction should be enforced at the infrastructure/firewall/reverse-proxy level where possible rather than relying only on frontend checks.
The application must not expose internal services such as PostgreSQL directly to users.
If external/public access is required later, use proper HTTPS, firewall rules, reverse proxy configuration, and appropriate access controls.

### Phase 9 — Testing + Security

Perform functional, integration, network, file, and basic security testing.
Test:

* Multiple simultaneous users
* One-to-one messaging
* Group messaging
* Message persistence
* Reconnection
* File upload
* File download
* Invalid files
* Large files
* Concurrent uploads
* Server restart
* Database restart/recovery scenarios
* Unauthorized file access
* Unauthorized conversation access
* Network access restrictions
  Security checks should include protection against:
* SQL injection
* XSS
* CSRF where applicable
* Path traversal
* Malicious file uploads
* Unauthorized API access
* Invalid WebSocket requests
* Oversized requests
* Input injection
* Sensitive information leakage
  Never place secrets in source control.
  Never expose database credentials to the frontend.

### Phase 10 — Company Server Deployment

Prepare the production deployment.
Production should contain:

* Chat application
* PostgreSQL
* Company file storage
* Required reverse proxy/web server
* HTTPS where applicable
* Firewall/network configuration
* Logging
* Backup strategy
  Document:
* Installation
* Configuration
* Starting/stopping the application
* Database setup
* Database migrations
* File-storage configuration
* Backup procedure
* Restore procedure
* Troubleshooting
  The deployment must be reproducible.
  Do not depend on the developer's personal computer for production operation.

### Phase 11 — Future AI Features

This phase is intentionally postponed.
Only begin after Phases 0–10 are completed and the core communication system is stable.
Potential future features:

* AI chatbot
* AI document Q&A
* Document summarization
* Company knowledge assistant
* AI search
* AI-assisted message/document analysis
  AI architecture must be designed separately when this phase begins.
  Do not add AI dependencies, API keys, vector databases, embeddings, or LLM infrastructure before Phase 11.

## 6. Application Architecture

Prefer a modular architecture with clear separation of responsibilities.
Suggested structure:

```text
company-chat/
├── app/
│   ├── api/
│   ├── chat/
│   ├── groups/
│   └── ...
├── components/
├── lib/
│   ├── db/
│   ├── realtime/
│   ├── files/
│   ├── validation/
│   └── ...
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── public/
├── uploads/
├── tests/
├── docs/
├── scripts/
├── .env.example
├── .gitignore
├── CLAUDE.md
├── package.json
└── README.md
```

Adjust the structure when necessary, but maintain clear separation between:

* UI
* API/server logic
* Database
* Real-time communication
* File storage
* Validation
* Configuration
* Tests
  Do not create folders or abstractions that have no meaningful purpose.

## 7. Environment Configuration

Use environment variables for environment-specific configuration.
Example categories:

```text
DATABASE_URL
APP_URL
PORT
UPLOAD_DIR
MAX_FILE_SIZE
NODE_ENV
```

Do not commit `.env` files containing secrets.
Maintain `.env.example` with safe placeholder values.
Do not hard-code the company's production IP address.
Production configuration must remain separate from development configuration.

## 8. Database Rules

Use PostgreSQL as the primary persistent database.
Do not use an in-memory database as the production database.
Use Prisma migrations for schema changes.
Use transactions when multiple related database operations must succeed together.
Add indexes for frequently queried fields.
Use UTC timestamps internally where practical and format timestamps for users in the UI.
Do not delete important records accidentally through cascading relationships.
Use appropriate foreign-key behavior.
Database credentials must never be exposed to client-side code.

## 9. API Rules

All server-side endpoints must:

* Validate input
* Validate request method
* Handle errors
* Return appropriate status codes
* Avoid leaking sensitive information
* Verify access to requested resources
  Never trust IDs supplied by the browser.
  Never assume that because a user knows a file/message/conversation ID they are authorized to access it.
  Keep business logic out of UI components where possible.

## 10. Real-Time Rules

Real-time events must be validated server-side.
Do not trust the client to claim:

* Sender identity
* Conversation membership
* File ownership
* Group membership
  The server must determine what the client is allowed to do.
  Persist important events/messages before treating them as successfully delivered.
  Handle reconnects gracefully.
  Avoid broadcasting sensitive data to users who are not members of the relevant conversation.

## 11. File Storage Rules

Files must be stored outside publicly accessible static assets unless there is a deliberate, reviewed reason to do otherwise.
Use generated storage identifiers.
Do not use the original filename directly as a filesystem path.
Sanitize filenames displayed in the UI.
Validate files server-side.
Configure upload limits.
Protect file download endpoints.
The application must verify that the requesting user has access to the file.
The file storage directory must not contain executable application code.

## 12. UI/UX Rules

The application should be:

* Simple
* Professional
* Fast
* Easy for non-technical employees
* Desktop-first but responsive
  Use consistent spacing, typography, buttons, forms, dialogs, notifications, and error messages.
  Avoid unnecessary animations.
  Provide clear loading states.
  Provide clear success/error feedback.
  Do not create unnecessary pages.
  Do not add features just because Teams has them.
  Only implement features required by the current project scope.

## 13. Error Handling

Never leave errors unhandled.
Display user-friendly messages in the UI.
Do not display:

* Database credentials
* Stack traces
* Internal filesystem paths
* Environment variables
* Internal server details
  Log useful technical information server-side.
  Do not log passwords, secrets, file contents, or sensitive personal information unnecessarily.

## 14. Logging

Implement useful application logging.
Logs should help diagnose:

* Server errors
* Database errors
* File-upload failures
* WebSocket failures
* Unexpected requests
* Deployment problems
  Avoid excessive logging.
  Do not log sensitive information.
  Production logging should be configurable.

## 15. Git and Version Control

Use Git throughout development.
Make focused commits.
Use meaningful commit messages.
Do not commit:

* `.env`
* Database passwords
* API keys
* Private certificates
* Large generated files
* User-uploaded files
* Temporary files
  Maintain a useful `.gitignore`.
  Use GitHub as the source-code repository.
  Do not push production secrets to GitHub.

## 16. Documentation Requirements

Maintain:

* README.md
* Architecture documentation
* Database documentation
* Setup instructions
* Deployment instructions
* Environment-variable documentation
* Troubleshooting documentation
  Update documentation when architecture or setup changes.
  A new developer should be able to understand how to run the project locally from the documentation.

## 17. Testing Strategy

Add tests progressively.
At minimum, test important:

* Database operations
* API endpoints
* Message operations
* Conversation membership
* File validation
* File access
* Real-time message behavior where practical
  Before declaring a phase complete:

1. Run the application.
2. Run relevant tests.
3. Check for build errors.
4. Check for TypeScript errors.
5. Test the feature manually.
6. Fix issues before moving forward.

## 18. Claude Code Working Rules

Claude Code must work incrementally.
Before making major changes:

1. Inspect the existing project.
2. Understand the current architecture.
3. Identify relevant files.
4. Explain the planned change briefly.
5. Implement only the requested scope.
6. Run appropriate tests/checks.
7. Report what changed.
8. Report any remaining issues.
   Do not overwrite working code unnecessarily.
   Do not rewrite the entire project to implement a small feature.
   Do not introduce unrelated changes.
   Do not install dependencies without a reason.
   Do not change the technology stack without discussing the reason.
   Do not skip validation because the feature appears simple.
   Do not mark a phase complete if it has known critical errors.
   When requirements are ambiguous, identify the ambiguity rather than inventing a business requirement.

## 19. Scope Control

The following are OUT OF SCOPE for the initial version unless explicitly requested:

* AI chatbot
* AI document analysis
* Video calls
* Voice calls
* Screen sharing
* Calendar
* Email integration
* Cloud storage
* Mobile applications
* Desktop applications
* Complex enterprise authentication
* Payment functionality
* Public user registration
* Social-media-style features
  Do not implement these automatically.

## 20. Security Priority

Security is a core requirement because the system will handle company conversations and files.
Even though the initial system does not require username/password login, treat all uploaded files and company messages as private company data.
Network restriction is not a replacement for secure server-side validation.
Every server-side operation must validate what the requester is allowed to access.
Never expose PostgreSQL directly to the network users.
Never expose internal configuration or secrets to browsers.
Never assume that hiding a URL provides security.

## 21. Production Architecture Target

The intended production architecture is:

```text
                    COMPANY INTERNET / NETWORK
                              │
                         Router/Firewall
                              │
                         Company Server
                              │
                ┌─────────────┴─────────────┐
                │                           │
          Chat Web Application        Reverse Proxy
                │                           │
                └─────────────┬─────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
               PostgreSQL          File Storage
```

Employees:

```text
Employee Computer
       │
     Browser
       │
       ↓
Company Chat Application
```

The exact server OS, IP address, firewall, ports, domain name, and reverse-proxy configuration will be determined during deployment based on the company's infrastructure.

## 22. Definition of Done

A phase is complete only when:

* The requested functionality is implemented.
* The application builds successfully.
* TypeScript checks pass.
* Relevant tests pass.
* Manual testing has been completed.
* Errors have been handled.
* Security considerations have been addressed.
* Documentation has been updated where necessary.
* No unrelated functionality was introduced.
* The implementation is ready for the next phase.

## 23. Current Development Rule

At the beginning of every new phase:

1. Review CLAUDE.md.
2. Review the current project state.
3. Review what was completed in previous phases.
4. Identify the exact scope of the current phase.
5. Do not implement future-phase functionality.
6. Implement the current phase.
7. Test it.
8. Document it.
9. Only then proceed to the next phase.
   The project's priority order is:
   **Reliability → Security → Simplicity → Maintainability → Performance → Additional Features**
   The goal is not to reproduce every Microsoft Teams feature. The goal is to build a reliable, private, company-hosted chat and file-transfer system that can later be extended with AI.
