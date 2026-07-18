package serviceauth

import (
	"crypto/ed25519"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	serviceTokenIssuer   = "singularity-api"
	maximumTokenLifetime = 30 * time.Second
	maximumClockSkew     = 2 * time.Second
)

type Claims struct {
	SpaceID string `json:"spaceId"`
	jwt.RegisteredClaims
}

type Verifier struct {
	instanceID string
	publicKeys map[string]ed25519.PublicKey
	spaceID    string
}

func NewVerifier(instanceID, spaceID string, publicKeys map[string]ed25519.PublicKey) *Verifier {
	return &Verifier{instanceID: instanceID, publicKeys: publicKeys, spaceID: spaceID}
}

func (verifier *Verifier) Verify(tokenString, requestID string, now time.Time) (*Claims, error) {
	if !canonicalUUIDPattern.MatchString(requestID) {
		return nil, errors.New("service request id is invalid")
	}
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(
		tokenString,
		claims,
		func(token *jwt.Token) (any, error) {
			if token.Method != jwt.SigningMethodEdDSA {
				return nil, errors.New("unexpected service token signing method")
			}
			keyID, ok := token.Header["kid"].(string)
			if !ok || keyID == "" {
				return nil, errors.New("service token key id is missing")
			}
			publicKey := verifier.publicKeys[keyID]
			if publicKey == nil {
				return nil, errors.New("service token key id is unknown")
			}
			return publicKey, nil
		},
		jwt.WithAudience(verifier.instanceID),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithIssuer(serviceTokenIssuer),
		jwt.WithLeeway(maximumClockSkew),
		jwt.WithTimeFunc(func() time.Time { return now }),
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
	)
	if err != nil || token == nil || !token.Valid {
		return nil, errors.New("service token is invalid")
	}
	if claims.IssuedAt == nil || claims.ExpiresAt == nil || claims.ID == "" || claims.ID != requestID || claims.SpaceID != verifier.spaceID {
		return nil, errors.New("service token identity is invalid")
	}
	if claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time) > maximumTokenLifetime || claims.ExpiresAt.Time.Before(claims.IssuedAt.Time) {
		return nil, errors.New("service token lifetime is invalid")
	}
	return claims, nil
}
