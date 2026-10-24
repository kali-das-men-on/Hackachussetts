"""Pydantic models for a report.

These map 1:1 to schema/report.schema.json (the shape of each line in
data/reports.jsonl) and to the `reports` table in schema/schema.sql. Keeping
them in sync means a FastAPI backend can read the files the Node server writes
today without any transformation.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Status = Literal["received", "in_review", "assigned", "in_progress", "resolved", "rejected"]
LocationSource = Literal["gps", "map", "address"]
Category = Literal["pothole", "streetlight", "trash", "graffiti", "sidewalk", "other"]
PhotoMime = Literal["image/jpeg", "image/png", "image/webp"]
AudioMime = Literal["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav"]


class Photo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Relative to data/, e.g. photos/R-1001.jpg.")
    mime: PhotoMime
    bytes: int = Field(ge=1)


class Audio(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Relative to data/, e.g. audio/R-1001.webm.")
    mime: AudioMime
    bytes: int = Field(ge=1)
    duration_s: Optional[float] = Field(default=None, ge=0, le=30)


class Location(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: LocationSource
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    accuracy_m: Optional[float] = Field(default=None, ge=0)
    address: Optional[str] = Field(default=None, max_length=300)


class Contact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Optional[str] = Field(default=None, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=32)


class Meta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: Optional[str] = Field(default=None, max_length=64)
    user_agent: Optional[str] = Field(default=None, max_length=300)
    was_queued_offline: bool = False


class StatusEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Status
    at: datetime
    note: Optional[str] = Field(default=None, max_length=300, description="Public note from staff.")


class Report(BaseModel):
    """One civic issue report, exactly as stored in data/reports.jsonl."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^R-[0-9]+$")
    client_report_id: str = Field(max_length=64)
    created_at: datetime
    submitted_at: Optional[datetime] = None
    status: Status = "received"
    updated_at: Optional[datetime] = None
    # Oldest first; older reports have none (treated as [received at created_at]).
    status_history: list[StatusEvent] = Field(default_factory=list)
    photo: Photo
    audio: Optional[Audio] = None
    location: Location
    description: Optional[str] = Field(default=None, max_length=500)
    # Not collected from the reporter: null at intake, filled in by AI analysis of the description.
    category: Optional[Category] = None
    contact: Contact = Field(default_factory=Contact)
    meta: Meta = Field(default_factory=Meta)
