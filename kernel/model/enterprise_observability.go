// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/siyuan-note/logging"
	"github.com/siyuan-note/siyuan/kernel/util"
)

type EnterpriseHealthSample struct {
	ErrorCode     string    `json:"errorCode,omitempty"`
	KernelVersion string    `json:"kernelVersion"`
	SampledAt     time.Time `json:"sampledAt"`
	Status        string    `json:"status"`
}

type EnterpriseCapacitySample struct {
	AssetBytes                 int64     `json:"assetBytes,omitempty"`
	DataBytes                  int64     `json:"dataBytes,omitempty"`
	ErrorCode                  string    `json:"errorCode,omitempty"`
	FileCount                  int64     `json:"fileCount,omitempty"`
	SampleDurationMilliseconds int64     `json:"sampleDurationMilliseconds"`
	SampledAt                  time.Time `json:"sampledAt"`
}

type EnterpriseObservationSample struct {
	Capacity EnterpriseCapacitySample `json:"capacity"`
	Health   EnterpriseHealthSample   `json:"health"`
}

var enterpriseObservation atomic.Pointer[EnterpriseObservationSample]
var enterpriseObservationSamplerRunning atomic.Bool

func StartEnterpriseObservationSampler(ctx context.Context, interval time.Duration) error {
	if interval < 10*time.Second {
		return errors.New("enterprise observation interval is too short")
	}
	if !enterpriseObservationSamplerRunning.CompareAndSwap(false, true) {
		return errors.New("enterprise observation sampler is already running")
	}
	defer enterpriseObservationSamplerRunning.Store(false)

	SampleEnterpriseObservabilityNow()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			SampleEnterpriseObservabilityNow()
		}
	}
}

func SampleEnterpriseObservabilityNow() *EnterpriseObservationSample {
	startedAt := time.Now()
	health := EnterpriseHealthSample{
		KernelVersion: util.Ver,
		SampledAt:     startedAt.UTC(),
		Status:        "ready",
	}
	if !util.IsBooted() {
		health.ErrorCode = "kernel-not-booted"
		health.Status = "unavailable"
	}

	dataBytes, assetBytes, fileCount, err := enterpriseCapacity()
	capacity := EnterpriseCapacitySample{
		AssetBytes:                 assetBytes,
		DataBytes:                  dataBytes,
		FileCount:                  fileCount,
		SampleDurationMilliseconds: time.Since(startedAt).Milliseconds(),
		SampledAt:                  time.Now().UTC(),
	}
	if err != nil {
		capacity.AssetBytes = 0
		capacity.DataBytes = 0
		capacity.FileCount = 0
		capacity.ErrorCode = "capacity-scan-failed"
		logging.LogWarnf("kernel.observation capacity sample failed: %s", err)
	}
	sample := &EnterpriseObservationSample{Capacity: capacity, Health: health}
	enterpriseObservation.Store(sample)
	return sample
}

func GetEnterpriseObservationSample() *EnterpriseObservationSample {
	sample := enterpriseObservation.Load()
	if sample == nil {
		return nil
	}
	copy := *sample
	return &copy
}

func enterpriseCapacity() (dataBytes, assetBytes, fileCount int64, err error) {
	err = filepath.WalkDir(util.DataDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&fs.ModeSymlink != 0 {
			return errors.New("symbolic links are not valid workspace capacity entries")
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if info.IsDir() {
			dataBytes += 4096
			return nil
		}
		if !info.Mode().IsRegular() {
			return errors.New("non-regular workspace capacity entry")
		}
		fileCount++
		dataBytes += info.Size()
		relative, relativeErr := filepath.Rel(util.DataDir, path)
		if relativeErr != nil {
			return relativeErr
		}
		for _, segment := range strings.Split(filepath.ToSlash(relative), "/") {
			if segment == "assets" {
				assetBytes += info.Size()
				break
			}
		}
		return nil
	})
	return
}
