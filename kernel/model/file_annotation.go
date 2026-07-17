// SiYuan - Refactor your thinking
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"path/filepath"

	"github.com/siyuan-note/filelock"
)

// CommitFileAnnotation owns the complete annotation mutation, including sync
// scheduling, so an encrypted notebook cannot lock between capability
// validation and the final side effect.
func CommitFileAnnotation(writePath string, data []byte, remove bool) error {
	boxID := ExtractBoxIDFromAssetsPath(writePath)
	if boxID == "" || !IsEncryptedBox(boxID) {
		if err := persistFileAnnotation(writePath, data, remove); err != nil {
			return err
		}
		IncSync()
		return nil
	}

	acquireBoxOperationLock(boxID)
	operationHeld := true
	defer func() {
		if operationHeld {
			releaseBoxOperationLock(boxID)
		}
	}()

	commitToken := acquireContentCommitToken(boxID)
	defer commitToken.release()
	// Admission and lifecycle ownership now cover the whole commit. Releasing
	// the operation gate lets LockBox reach the SQL drain and wait on this token.
	releaseBoxOperationLock(boxID)
	operationHeld = false
	if fileAnnotationCommitOwnedHook != nil {
		fileAnnotationCommitOwnedHook(boxID)
	}

	dek, err := GetDEKIfUnlocked(boxID)
	if err != nil {
		return err
	}
	defer zeroAndClear(dek)

	writeData := data
	if !remove {
		writeData, err = EncryptAsset(boxID, filepath.Base(writePath), dek, data)
		if err != nil {
			return err
		}
	}
	if err = persistFileAnnotation(writePath, writeData, remove); err != nil {
		return err
	}
	IncSync()
	return nil
}

// fileAnnotationCommitOwnedHook observes the point after capability handoff
// while admission and lifecycle ownership still cover the pending mutation.
var fileAnnotationCommitOwnedHook func(boxID string)

func persistFileAnnotation(writePath string, data []byte, remove bool) error {
	if remove {
		return filelock.Remove(writePath)
	}
	return filelock.WriteFile(writePath, data)
}
