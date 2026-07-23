-- L4 governance actions use the same immutable audit chain as access changes.
-- Extend the existing target contract without rewriting already-applied migrations.
ALTER TABLE "audit_events"
    DROP CONSTRAINT "audit_events_target_type_check",
    ADD CONSTRAINT "audit_events_target_type_check" CHECK (
        "target_type" IN (
            'api-key',
            'backup',
            'comment',
            'document',
            'group',
            'history',
            'invitation',
            'membership',
            'notification',
            'oidc-provider',
            'organization',
            'restore',
            'saml-provider',
            'scim-token',
            'session',
            'share',
            'space',
            'template',
            'user'
        )
    );
