PRAGMA foreign_keys= off;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS `new_transaction`
(
    transaction_id   CHAR(50)    NOT NULL PRIMARY KEY CHECK (length(transaction_id) <= 50),
    shard_id         CHAR(50)    NOT NULL CHECK (length(shard_id) <= 50),
    transaction_date INT         NOT NULL CHECK (length(transaction_date) <= 10 AND TYPEOF(transaction_date) = 'integer'),
    node_id_origin   CHAR(34)    NOT NULL CHECK (length(node_id_origin) <= 34),
    version          CHAR(4)     NOT NULL DEFAULT '0a0' CHECK (length(version) <= 4),
    payload_hash     CHAR(50)    NOT NULL CHECK (length(payload_hash) <= 50),
    stable_date      INT         NULL CHECK (length(stable_date) <= 10 AND (TYPEOF(stable_date) IN ('integer', 'null'))),
    is_stable        TINYINT     NOT NULL DEFAULT 0 CHECK (is_stable = 0 OR is_stable = 1),
    parent_date      INT         NULL CHECK(length(parent_date) <= 10 AND TYPEOF(parent_date) IN ('integer', 'null')),
    is_parent        TINYINT     NOT NULL DEFAULT 0 CHECK (is_parent = 0 OR is_parent = 1),
    timeout_date     INT         NULL CHECK(length(timeout_date) <= 10 AND TYPEOF(timeout_date) IN ('integer', 'null')),
    is_timeout       TINYINT     NOT NULL DEFAULT 0 CHECK (is_timeout = 0 OR is_timeout = 1),
    status           TINYINT     NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date      INT         NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer')
);
INSERT INTO `new_transaction` SELECT * FROM `transaction`;
DROP TABLE `transaction`;
ALTER TABLE `new_transaction` RENAME TO `transaction`;

CREATE INDEX idx_transaction_status_is_stable_transaction_date ON `transaction` (status, is_stable, transaction_date);
CREATE INDEX idx_transaction_id_is_stable_is_parent ON `transaction` (transaction_id, is_stable, is_parent);
CREATE INDEX idx_transaction_date ON `transaction` (transaction_date);
CREATE INDEX idx_transaction_id_transaction_date ON `transaction` (transaction_id, transaction_date);
CREATE INDEX idx_transaction_is_parent ON `transaction` (is_parent);
CREATE INDEX idx_transaction_is_stable_transaction_date ON `transaction` (is_stable, transaction_date);
CREATE INDEX idx_transaction_create_date ON `transaction` (create_date);

CREATE TABLE IF NOT EXISTS new_transaction_parent
(
    transaction_id_child  CHAR(50) NOT NULL CHECK (length(transaction_id_child) <= 50),
    transaction_id_parent CHAR(50) NOT NULL CHECK (length(transaction_id_parent) <= 50),
    shard_id              CHAR(50) NOT NULL CHECK (length(shard_id) <= 50),
    status                TINYINT  NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date           INT      NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer'),
    PRIMARY KEY (transaction_id_parent, transaction_id_child),
    FOREIGN KEY (transaction_id_child) REFERENCES `transaction` (transaction_id)
);
INSERT INTO new_transaction_parent SELECT * FROM transaction_parent;
DROP TABLE transaction_parent;
ALTER TABLE new_transaction_parent RENAME TO transaction_parent;

CREATE INDEX idx_transaction_parent_transaction_id_child ON transaction_parent (transaction_id_child);
CREATE INDEX idx_transaction_parent_create_date ON transaction_parent (create_date);

CREATE TABLE IF NOT EXISTS new_transaction_signature
(
    transaction_id CHAR(50) NOT NULL CHECK (length(transaction_id) <= 50),
    shard_id       CHAR(50) NOT NULL CHECK (length(shard_id) <= 50),
    address_base   CHAR(34) NOT NULL CHECK (length(address_base) <= 34),
    signature      CHAR(88) NOT NULL CHECK (length(signature) <= 88),
    status         TINYINT  NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date    INT      NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer'),
    PRIMARY KEY (transaction_id, address_base),
    FOREIGN KEY (transaction_id) REFERENCES `transaction` (transaction_id)
);
INSERT INTO new_transaction_signature SELECT * FROM transaction_signature;
DROP TABLE transaction_signature;
ALTER TABLE new_transaction_signature RENAME TO transaction_signature;

CREATE INDEX idx_transaction_signature_address ON transaction_signature (address_base);
CREATE INDEX idx_transaction_signature_create_date ON transaction_signature (create_date);

CREATE TABLE IF NOT EXISTS new_transaction_input
(
    transaction_id          CHAR(50) NOT NULL CHECK (length(transaction_id) <= 50),
    shard_id                CHAR(50) NOT NULL CHECK (length(shard_id) <= 50),
    input_position          TINYINT  NOT NULL CHECK (length(input_position) <= 3 AND TYPEOF(input_position) = 'integer'),
    output_transaction_id   CHAR(50) NULL CHECK (length(output_transaction_id) <= 50),
    output_position         TINYINT  NULL CHECK(length(output_position) <= 3 AND TYPEOF(output_position) IN ('integer', 'null')),
    output_shard_id         CHAR(50) NULL CHECK (length(output_shard_id) <= 50),
    output_transaction_date INT      NULL CHECK(length(output_transaction_date) <= 10 AND TYPEOF(output_transaction_date) IN ('integer', 'null')),
    double_spend_date       INT      NULL CHECK(length(double_spend_date) <= 10 AND TYPEOF(double_spend_date) IN ('integer', 'null')),
    is_double_spend         TINYINT  NULL DEFAULT 0 CHECK (is_double_spend = 0 OR is_double_spend = 1 OR is_double_spend IS NULL),
    address                 CHAR(72) NULL CHECK (length(address) <= 72),
    address_key_identifier  CHAR(34) NULL CHECK (length(address_key_identifier) <= 34),
    status                  TINYINT  NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date             INT      NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer'),
    PRIMARY KEY (transaction_id, input_position),
    FOREIGN KEY (transaction_id) REFERENCES `transaction` (transaction_id)
);
INSERT INTO new_transaction_input SELECT * FROM transaction_input;
DROP TABLE transaction_input;
ALTER TABLE new_transaction_input RENAME TO transaction_input;

CREATE INDEX idx_transaction_input_address_key_identifier ON transaction_input (address_key_identifier);
CREATE INDEX idx_transaction_input_address_is_double_spend ON transaction_input (address, is_double_spend);
CREATE INDEX idx_transaction_input_transaction_id ON transaction_input (transaction_id);
CREATE INDEX idx_transaction_input_output_transaction_id_output_position ON transaction_input (output_transaction_id, output_position);
CREATE INDEX idx_transaction_input_create_date ON transaction_input (create_date);

CREATE TABLE IF NOT EXISTS new_transaction_output
(
    transaction_id         CHAR(50) NOT NULL CHECK (length(transaction_id) <= 50),
    shard_id               CHAR(50) NOT NULL CHECK (length(shard_id) <= 50),
    output_position        TINYINT  NOT NULL CHECK (length(output_position) <= 3 AND TYPEOF(output_position) = 'integer'),
    address                CHAR(72) NOT NULL CHECK (length(address) <= 72),
    address_key_identifier CHAR(34) NOT NULL CHECK (length(address_key_identifier) <= 34),
    amount                 BIGINT   NOT NULL CHECK (TYPEOF(amount) IN ('integer','real')),
    stable_date            INT      NULL CHECK(length(stable_date) <= 10 AND TYPEOF(stable_date) IN ('integer', 'null')), -- NULL if not stable yet
    is_stable              TINYINT  NOT NULL DEFAULT 0 CHECK (is_stable = 0 OR is_stable = 1),
    spent_date             INT      NULL CHECK(length(spent_date) <= 10 AND TYPEOF(spent_date) IN ('integer', 'null')),
    is_spent               TINYINT  NOT NULL DEFAULT 0 CHECK (is_spent = 0 OR is_spent = 1),
    double_spend_date      INT      NULL CHECK(length(double_spend_date) <= 10 AND TYPEOF(double_spend_date) IN ('integer', 'null')), -- NOT NULL if double spend
    is_double_spend        TINYINT  NOT NULL DEFAULT 0 CHECK (is_double_spend = 0 OR is_double_spend = 1),
    status                 TINYINT  NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date            INT      NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer'),
    PRIMARY KEY (transaction_id, output_position),
    FOREIGN KEY (transaction_id) REFERENCES `transaction` (transaction_id)
);
INSERT INTO new_transaction_output SELECT * FROM transaction_output;
DROP TABLE transaction_output;
ALTER TABLE new_transaction_output RENAME TO transaction_output;

CREATE INDEX idx_transaction_output_address_key_identifier ON transaction_output (address_key_identifier);
CREATE INDEX idx_transaction_output_address_is_spent ON transaction_output (address, is_spent);
CREATE INDEX idx_transaction_output_address_create_date ON transaction_output (address, create_date);
CREATE INDEX idx_transaction_output_address_is_stable_is_spent_is_double_spend ON transaction_output (address, is_stable, is_spent, is_double_spend);
CREATE INDEX idx_transaction_output_transaction_id_is_stable_is_double_spend ON transaction_output (transaction_id, is_stable, is_double_spend);
CREATE INDEX idx_transaction_output_transaction_id_is_spent ON transaction_output (transaction_id, is_spent);
CREATE INDEX idx_transaction_output_create_date ON transaction_output (create_date);


CREATE TABLE IF NOT EXISTS new_transaction_output_attribute
(
    transaction_output_id      CHAR(50) NOT NULL CHECK (length(transaction_output_id) <= 50),
    transaction_output_type_id CHAR(20) NOT NULL CHECK (length(transaction_output_type_id) <= 20),
    shard_id                   CHAR(50) NOT NULL CHECK (length(shard_id) <= 50),
    value                      TEXT     NOT NULL,
    status                     TINYINT  NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date                INT      NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer'),
    PRIMARY KEY (transaction_output_id, transaction_output_type_id),
    FOREIGN KEY (transaction_output_id) REFERENCES transaction_output (transaction_id)
);
INSERT INTO new_transaction_output_attribute SELECT * FROM transaction_output_attribute;
DROP TABLE transaction_output_attribute;
ALTER TABLE new_transaction_output_attribute RENAME TO transaction_output_attribute;

CREATE INDEX idx_transaction_output_attribute_create_date ON transaction_output_attribute (create_date);

CREATE TABLE IF NOT EXISTS new_audit_verification
(
    transaction_id     CHAR(50) NOT NULL PRIMARY KEY CHECK (length(transaction_id) <= 50),
    shard_id           CHAR(50) NOT NULL CHECK (length(shard_id) <= 50),
    attempt_count      INT      NOT NULL DEFAULT 0 CHECK (length(attempt_count) <= 10 AND TYPEOF(attempt_count) = 'integer'),
    verification_count INT      NOT NULL DEFAULT 0 CHECK (length(verification_count) <= 10 AND TYPEOF(verification_count) = 'integer'),
    verified_date      INT      NULL CHECK(length(verified_date) <= 10 AND TYPEOF(verified_date) IN ('integer', 'null')),
    is_verified        TINYINT  NOT NULL DEFAULT 0 CHECK (is_verified = 0 OR is_verified = 1),
    status             TINYINT  NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date        INT      NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer'),
    FOREIGN KEY (transaction_id) REFERENCES `transaction` (transaction_id)
);
INSERT INTO new_audit_verification SELECT * FROM audit_verification;
DROP TABLE audit_verification;
ALTER TABLE new_audit_verification RENAME TO audit_verification;

CREATE INDEX idx_audit_verification_transaction_id_is_verified ON audit_verification (transaction_id, is_verified);
CREATE INDEX idx_audit_verification_verified_date ON audit_verification (verified_date);
CREATE INDEX idx_audit_verification_create_date ON audit_verification (create_date);

CREATE TABLE IF NOT EXISTS new_audit_point
(
    audit_point_id CHAR(20) NOT NULL CHECK (length(audit_point_id) <= 20),
    transaction_id CHAR(50) NOT NULL CHECK (length(transaction_id) <= 50),
    shard_id       CHAR(50) NOT NULL CHECK (length(shard_id) <= 50),
    status         TINYINT  NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date    INT      NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer'),
    PRIMARY KEY (audit_point_id, transaction_id),
    FOREIGN KEY (transaction_id) REFERENCES `transaction` (transaction_id)
);
INSERT INTO new_audit_point SELECT * FROM audit_point;
DROP TABLE audit_point;
ALTER TABLE new_audit_point RENAME TO audit_point;

CREATE INDEX idx_audit_point_transaction_id ON audit_point (transaction_id);
CREATE INDEX idx_audit_point_status_transaction_id ON audit_point (status, transaction_id);
CREATE INDEX idx_audit_point_id ON audit_point (audit_point_id);
CREATE INDEX idx_audit_point_create_date ON audit_point (create_date);

DROP TABLE schema_information;
CREATE TABLE IF NOT EXISTS schema_information
(
    key         TEXT         NOT NULL UNIQUE,
    value       TEXT         NOT NULL,
    status      TINYINT      NOT NULL DEFAULT 1 CHECK (length(status) <= 3 AND TYPEOF(status) = 'integer'),
    create_date INT          NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)) CHECK(length(create_date) <= 10 AND TYPEOF(create_date) = 'integer')
    );
CREATE INDEX idx_schema_information_create_date ON schema_information (create_date);

INSERT INTO schema_information (key, value) VALUES ("version", "9");

COMMIT;
