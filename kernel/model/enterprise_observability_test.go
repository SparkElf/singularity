package model

import (
	"context"
	"testing"
	"time"
)

func TestEnterpriseObservationSamplerRejectsUnboundedInterval(t *testing.T) {
	if err := StartEnterpriseObservationSampler(context.Background(), 9*time.Second); err == nil {
		t.Fatal("short observation interval was accepted")
	}
}

func TestEnterpriseObservationSamplerStopsOnCancellationAndPublishesSnapshot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := StartEnterpriseObservationSampler(ctx, 10*time.Second); err != nil {
		t.Fatalf("observation sampler returned an error: %v", err)
	}
	sample := GetEnterpriseObservationSample()
	if sample == nil {
		t.Fatal("observation sampler did not publish a snapshot")
	}
	if sample.Health.KernelVersion == "" || sample.Capacity.SampledAt.IsZero() {
		t.Fatalf("observation snapshot is incomplete: %#v", sample)
	}
	if !sample.Health.SampledAt.Equal(sample.Capacity.SampledAt) {
		t.Fatalf("observation snapshot timestamps diverged: health=%s capacity=%s", sample.Health.SampledAt, sample.Capacity.SampledAt)
	}

	sample.Health.KernelVersion = "mutated"
	copy := GetEnterpriseObservationSample()
	if copy == nil || copy.Health.KernelVersion == "mutated" {
		t.Fatal("observation snapshot was not copied at the read boundary")
	}
}
