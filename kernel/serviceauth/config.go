package serviceauth

import (
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"regexp"
	"strings"
)

const (
	enterpriseModeEnv       = "SINGULARITY_KERNEL_ENTERPRISE"
	kernelInstanceIDEnv     = "SINGULARITY_KERNEL_INSTANCE_ID"
	spaceIDEnv              = "SINGULARITY_KERNEL_SPACE_ID"
	publicKeyRingFileEnv    = "SINGULARITY_KERNEL_SERVICE_KEYS_FILE"
	listenAddressEnv        = "SINGULARITY_KERNEL_LISTEN_ADDRESS"
	serverCertificateEnv    = "SINGULARITY_KERNEL_TLS_CERT_FILE"
	serverPrivateKeyEnv     = "SINGULARITY_KERNEL_TLS_KEY_FILE"
	trustedClientCAFileEnv  = "SINGULARITY_KERNEL_CLIENT_CA_FILE"
	gatewayClientDNSNameEnv = "SINGULARITY_KERNEL_GATEWAY_CLIENT_DNS_NAME"
)

var canonicalUUIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type keyRingDocument struct {
	Keys []keyRingEntry `json:"keys"`
}

type keyRingEntry struct {
	KeyID        string `json:"kid"`
	PublicKeyPEM string `json:"publicKeyPem"`
}

type Configuration struct {
	instanceID      string
	listenAddress   string
	routeIdentities map[routeKey]RouteIdentityRequirement
	spaceID         string
	tlsConfig       *tls.Config
	verifier        *Verifier
}

type EnvironmentLookup func(string) (string, bool)

func LoadFromEnvironment() (*Configuration, error) {
	return Load(os.LookupEnv)
}

func Load(lookup EnvironmentLookup) (*Configuration, error) {
	mode, configured := lookup(enterpriseModeEnv)
	if !configured {
		return nil, nil
	}
	mode = strings.TrimSpace(mode)
	if strings.EqualFold(mode, "false") || mode == "0" {
		return nil, nil
	}
	if mode != "1" && !strings.EqualFold(mode, "true") {
		return nil, errors.New("invalid enterprise kernel mode")
	}

	instanceID, instanceConfigured := nonEmptyEnvironmentValue(lookup, kernelInstanceIDEnv)
	spaceID, spaceConfigured := nonEmptyEnvironmentValue(lookup, spaceIDEnv)
	keyRingPath, keyRingConfigured := nonEmptyEnvironmentValue(lookup, publicKeyRingFileEnv)
	listenAddressValue, listenAddressConfigured := nonEmptyEnvironmentValue(lookup, listenAddressEnv)
	certificatePath, certificateConfigured := nonEmptyEnvironmentValue(lookup, serverCertificateEnv)
	privateKeyPath, privateKeyConfigured := nonEmptyEnvironmentValue(lookup, serverPrivateKeyEnv)
	clientCAPath, clientCAConfigured := nonEmptyEnvironmentValue(lookup, trustedClientCAFileEnv)
	gatewayClientDNSName, gatewayClientDNSNameConfigured := nonEmptyEnvironmentValue(lookup, gatewayClientDNSNameEnv)
	if !instanceConfigured || !spaceConfigured || !canonicalUUIDPattern.MatchString(instanceID) || !canonicalUUIDPattern.MatchString(spaceID) || !keyRingConfigured || !listenAddressConfigured || !certificateConfigured || !privateKeyConfigured || !clientCAConfigured || !gatewayClientDNSNameConfigured {
		return nil, errors.New("enterprise kernel credentials are incomplete")
	}
	listenAddress, err := parseListenAddress(listenAddressValue)
	if err != nil {
		return nil, err
	}

	publicKeys, err := loadPublicKeyRing(keyRingPath)
	if err != nil {
		return nil, fmt.Errorf("load service public keys: %w", err)
	}
	tlsConfig, err := loadServerTLSConfiguration(certificatePath, privateKeyPath, clientCAPath, gatewayClientDNSName)
	if err != nil {
		return nil, fmt.Errorf("load enterprise TLS identity: %w", err)
	}

	return &Configuration{
		instanceID:      instanceID,
		listenAddress:   listenAddress,
		routeIdentities: make(map[routeKey]RouteIdentityRequirement),
		spaceID:         spaceID,
		tlsConfig:       tlsConfig,
		verifier:        NewVerifier(instanceID, spaceID, publicKeys),
	}, nil
}

func parseListenAddress(value string) (string, error) {
	address, err := netip.ParseAddr(value)
	if err != nil {
		return "", errors.New("enterprise kernel listen address is invalid")
	}
	address = address.Unmap()
	if !address.IsLoopback() && !address.IsPrivate() {
		return "", errors.New("enterprise kernel listen address is not private")
	}
	return address.String(), nil
}

func nonEmptyEnvironmentValue(lookup EnvironmentLookup, name string) (string, bool) {
	value, found := lookup(name)
	value = strings.TrimSpace(value)
	return value, found && value != ""
}

func loadPublicKeyRing(path string) (map[string]ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	document := keyRingDocument{}
	if err = json.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	if len(document.Keys) == 0 {
		return nil, errors.New("service public key ring is empty")
	}

	keys := make(map[string]ed25519.PublicKey, len(document.Keys))
	for _, entry := range document.Keys {
		entry.KeyID = strings.TrimSpace(entry.KeyID)
		if entry.KeyID == "" || keys[entry.KeyID] != nil {
			return nil, errors.New("service public key ring contains an invalid key id")
		}
		block, remainder := pem.Decode([]byte(entry.PublicKeyPEM))
		if block == nil || strings.TrimSpace(string(remainder)) != "" {
			return nil, errors.New("service public key is not PEM")
		}
		parsed, parseErr := x509.ParsePKIXPublicKey(block.Bytes)
		if parseErr != nil {
			return nil, parseErr
		}
		publicKey, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return nil, errors.New("service public key is not Ed25519")
		}
		keys[entry.KeyID] = publicKey
	}
	return keys, nil
}

func loadServerTLSConfiguration(certificatePath, privateKeyPath, clientCAPath, gatewayClientDNSName string) (*tls.Config, error) {
	certificate, err := tls.LoadX509KeyPair(certificatePath, privateKeyPath)
	if err != nil {
		return nil, err
	}
	clientCA, err := os.ReadFile(clientCAPath)
	if err != nil {
		return nil, err
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(clientCA) {
		return nil, errors.New("trusted client CA file is invalid")
	}
	return &tls.Config{
		Certificates: []tls.Certificate{certificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		MinVersion:   tls.VersionTLS13,
		NextProtos:   []string{"http/1.1"},
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("gateway client certificate chain is invalid")
			}
			if err := state.PeerCertificates[0].VerifyHostname(gatewayClientDNSName); err != nil {
				return errors.New("gateway client certificate identity is invalid")
			}
			return nil
		},
	}, nil
}

func (configuration *Configuration) InstanceID() string {
	return configuration.instanceID
}

func (configuration *Configuration) ListenAddress() string {
	return configuration.listenAddress
}

func (configuration *Configuration) SpaceID() string {
	return configuration.spaceID
}

func (configuration *Configuration) ServerTLSConfig() *tls.Config {
	return configuration.tlsConfig.Clone()
}
