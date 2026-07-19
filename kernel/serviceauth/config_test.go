package serviceauth

import "testing"

func TestParseListenAddressAcceptsLoopbackAndPrivateAddresses(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string
	}{
		{name: "IPv4 loopback", value: "127.0.0.1", want: "127.0.0.1"},
		{name: "RFC1918 10", value: "10.42.0.8", want: "10.42.0.8"},
		{name: "RFC1918 172", value: "172.20.0.8", want: "172.20.0.8"},
		{name: "RFC1918 192", value: "192.168.42.8", want: "192.168.42.8"},
		{name: "IPv6 loopback", value: "::1", want: "::1"},
		{name: "IPv6 unique local", value: "fd42::8", want: "fd42::8"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseListenAddress(test.value)
			if err != nil {
				t.Fatalf("parse listen address: %v", err)
			}
			if got != test.want {
				t.Fatalf("parse listen address = %q, want %q", got, test.want)
			}
		})
	}
}

func TestParseListenAddressRejectsUntrustedAddresses(t *testing.T) {
	for _, value := range []string{
		"",
		"0.0.0.0",
		"::",
		"8.8.8.8",
		"2001:4860:4860::8888",
		"kernel.internal",
	} {
		t.Run(value, func(t *testing.T) {
			if _, err := parseListenAddress(value); err == nil {
				t.Fatalf("parse listen address %q unexpectedly succeeded", value)
			}
		})
	}
}

func TestLoadRequiresExplicitListenAddress(t *testing.T) {
	environment := map[string]string{
		enterpriseModeEnv:       "1",
		gatewayClientDNSNameEnv: "gateway.internal",
		kernelInstanceIDEnv:     "11111111-1111-4111-8111-111111111111",
		publicKeyRingFileEnv:    "/missing/service-keys.json",
		serverCertificateEnv:    "/missing/server.crt",
		serverPrivateKeyEnv:     "/missing/server.key",
		spaceIDEnv:              "22222222-2222-4222-8222-222222222222",
		trustedClientCAFileEnv:  "/missing/client-ca.crt",
	}

	configuration, err := Load(func(name string) (string, bool) {
		value, found := environment[name]
		return value, found
	})
	if err == nil {
		t.Fatal("load enterprise configuration without a listen address unexpectedly succeeded")
	}
	if err.Error() != "enterprise kernel credentials are incomplete" {
		t.Fatalf("load enterprise configuration error = %q", err)
	}
	if configuration != nil {
		t.Fatal("load enterprise configuration returned a partial configuration")
	}
}
