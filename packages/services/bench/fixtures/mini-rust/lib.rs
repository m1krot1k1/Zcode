//! Fixture crate used to prove Rust AST chunking and cross-symbol edges.

pub struct WorkspaceIdentity {
    pub raw: String,
}

pub enum IndexState {
    Idle,
    Indexing,
    Ready,
}

pub trait IdentityResolver {
    fn resolve(&self) -> String;
}

impl WorkspaceIdentity {
    pub fn new(raw: &str) -> Self {
        Self { raw: raw.to_string() }
    }

    pub fn normalized(&self) -> String {
        self.raw.trim().to_string()
    }
}

impl IdentityResolver for WorkspaceIdentity {
    fn resolve(&self) -> String {
        self.normalized()
    }
}

pub fn resolve_identity(identity: &str, fallback: &str) -> String {
    let trimmed = identity.trim();
    if trimmed.is_empty() {
        fallback.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn build_state(identity: &str) -> (String, IndexState) {
    let key = resolve_identity(identity, "/workspace");
    (key, IndexState::Ready)
}
