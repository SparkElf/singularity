ALTER TABLE "audit_events"
    DROP CONSTRAINT "audit_events_target_check",
    ADD CONSTRAINT "audit_events_target_id_check" CHECK (
        "target_id" ~ '[^[:space:]]'
    ),
    ADD CONSTRAINT "audit_events_target_type_check" CHECK (
        "target_type" IN (
            'backup',
            'document',
            'group',
            'invitation',
            'membership',
            'oidc-provider',
            'organization',
            'restore',
            'session',
            'share',
            'space',
            'user'
        )
    );
